/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextFunction, Request, Response } from 'express';
import { isEmpty, omit, uniq, uniqBy } from 'lodash';
import moment from 'moment';

import logger from '../logger';
import { DB } from '../config/db';
import { ClientError } from '../error';
import { Shiphero, Shipengine } from '../integrations';
import { INTERACTION_TYPES, INTERACTION_TYPES_MAPPED } from '../constants/interaction';
import { checkYesOrNoValue } from '../utils';
import {
  FLAVOR_CODES,
  ORDER_TYPE_DES,
  ORDER_TYPES_CODE,
  SHIPMENT_TYPE_NAME,
  STAGE_TYPE,
  DATE,
  STATUSES,
  WORD_MAP
} from '../constants';
import {
  validateBundles,
  getBundlesReachedReorderCount,
  getShipmentsAndLineItems,
  getNumberArray,
  getUniqueProductsFromBundles,
  enqueueEmail,
  getMessageTypeIdByFlavor,
  getMessageTypeIdByShipmentStatus,
  calculateQuantity,
  getFlavorDescription,
  createCrelioOrderWithPatientRegistration,
  validateGeoGraphicalExclusion,
  callTriggerMethodToInsertTheLastInteractionRecord,
  createMyLabBoxOrder,
  QRCodePDFCreation,
  createOutShipmentWalletAndLedger,
  createSelectorURL,
  updateBunldeQuantity
} from '../helpers';
import {
  CreateOrderRequest,
  BundleRequest,
  User,
  BundleWithProducts,
  BundleProductReorderCount,
  Country,
  City,
  Product,
  Experience,
  ExperienceWithBundle,
  ObservationFlowProduct,
  ExperienceByAccountFlowLinker,
  TestAssignment,
  GlobalSetting,
  ShipmentAndLineItems,
  Shipment,
  CarrierCode,
  UserPurchase,
  PurchaseAssignment,
  AssignOrderRequest,
  UpdateOrderRequest,
  ShipmentProductsMappings,
  Assignment,
  ListOrder,
  BundleWithTestAssignment,
  LineItem,
  LineItemProduct,
  SupportEntityCredentialsType,
  PatientProviderLinkerType,
  MessageTemplate,
  UserSelectedBundleListsType,
  ShipmentEventHistoryType,
  OrderWithBundleAndShipmentRecipient
} from '../types';
import {
  Bundles,
  CarrierCodes,
  CountryList,
  ExperiencesByAccount,
  ExperiencesByAccountFlowLinker,
  GlobalSettings,
  GroupDetails,
  GroupMemberships,
  ObservationFlowLinkerProduct,
  OrderBundleMapping,
  OrderEventHistory,
  Orders,
  OutboundWebhookQueue,
  Products,
  ShipmentEventHistory,
  ShipmentOutboundMapping,
  ShipmentProductsMapping,
  ShipmentRecipients,
  Shipments,
  SupportEntity,
  TestAssignments,
  USCities,
  UserPurchases,
  UserPurchasesAttributes,
  Users,
  ThirdPartyOrders,
  Tasks,
  CustomerWallet,
  AccountsControllingSupportEntityCatalogs,
  UserSelectedBundleLists,
  ShipmentCarrierMapping,
  Status,
  Accounts,
  UserConsumedTestsObservations,
  UsersByAccount,
  PatientProviderLinker,
  MessageTemplates,
  EmailQueue,
  TestAssigmentObsevationLinker
} from '../model';
import { validateOrderStatusExternalShipmentInformation } from '../validations';

const { ORDER_CREATION_KEY } = process.env;

export const createOrder = async (request: Request, response: Response, next: NextFunction): Promise<any> => {
  await DB.begin();
  try {
    logger.info('Ininitiating the order creation...');
    const account = request.account;
    const payload: CreateOrderRequest = request.body;
    const orderingUserEmail = payload.ordering_entity_info.ordered_by_email;
    const orderingUser = await Users.getUserBy(account.account_id, 'email', orderingUserEmail);
    let testAssignmentData: PurchaseAssignment[] = [];
    if (isEmpty(orderingUser))
      throw new ClientError({
        message: `Ordering user with email ${orderingUserEmail} not found. Cannot process order.`
      });
    if (orderingUser.account_id !== account.account_id)
      throw new ClientError({
        message: `The ordering user with ${orderingUserEmail} does not belong to account id ${account.account_id}. Cannot process order.`
      });
    // to validate the external shipment information
    if (['Y', 'Yes', 'yes', 'y'].includes(payload.external_shipment_information?.shipment_handled_externally)) {
      await validateOrderStatusExternalShipmentInformation(payload, account);
    }
    const skus: string[] = payload.bundles.map((bundle: BundleRequest) => bundle.sku);
    const dbBundles: BundleWithProducts[] = await Bundles.getBundlesWithProductsBySKUs(skus);
    if (isEmpty(dbBundles))
      throw new ClientError({ message: `Bundle with SKU ${skus[0]} not found. Cannot process order.` });
    const bundles: BundleWithProducts[] = validateBundles({
      orderType: payload.order_type,
      reqBundles: payload.bundles,
      dbBundles
    });
    const normalBundles: BundleWithProducts[] = bundles.filter(
      (bundle: BundleWithProducts) => !bundle.user_selected_bundle
    );
    const usbBundles: BundleWithProducts[] = bundles.filter(
      (bundle: BundleWithProducts) => bundle.user_selected_bundle
    );
    const globalSettings: GlobalSetting = await GlobalSettings.getGlobalSettings();
    const accountsControllingSupportEntityCatalogs = await AccountsControllingSupportEntityCatalogs.getBys({
      account_id: account.account_id
    });
    const accountsControllingSupportEntityCatalogsIds = accountsControllingSupportEntityCatalogs.map(
      (ac: { support_entity_id: number }) => ac.support_entity_id
    );
    let userSelectedBundleLists: UserSelectedBundleListsType[] = !isEmpty(usbBundles)
      ? await UserSelectedBundleLists.getUSBLByIdIn(
          usbBundles.map((bundle: BundleWithProducts) => bundle.user_selected_bundle_id)
        )
      : [];

    const disAllowedBundleProduct: { message: string }[] = [];
    if (!isEmpty(normalBundles)) {
      const products: Product[] = normalBundles.flatMap((bundle: BundleWithProducts) => bundle.products);
      const productIds: number[] = products.map((product: Product) => product.id);
      const geoGraphicalDisallowedProducts: { id: number; exclusion_region: { [key: string]: any } }[] =
        await Products.getDisallowedProducts(productIds);
      logger.info('validating the  geoGraphical exclusions products ...');
      await validateGeoGraphicalExclusion(
        payload.ship_to,
        normalBundles,
        geoGraphicalDisallowedProducts,
        disAllowedBundleProduct
      );

      if (disAllowedBundleProduct.length === productIds.length) {
        throw new ClientError({
          message:
            'The following bundle(s) are not available because of a geographical exclusion preventing the order from being fulfilled in (geography)'
        });
      }
    }

    if (!isEmpty(userSelectedBundleLists)) {
      userSelectedBundleLists.forEach((usb: UserSelectedBundleListsType) => {
        if (usb.account_id !== account.account_id) {
          disAllowedBundleProduct.push({
            message: `The USB with sku ${usb.bundle_sku} is not allowed because it is from another account.`
          });
          userSelectedBundleLists = userSelectedBundleLists.filter(
            (item: UserSelectedBundleListsType) => item.id !== usb.id
          );
        }
      });
    }

    userSelectedBundleLists = userSelectedBundleLists.map((usb: UserSelectedBundleListsType) => ({
      ...usb,
      quantity:
        usbBundles.find((bundle: BundleWithProducts) => bundle.user_selected_bundle_id === usb.id)?.quantity || 1
    }));

    const country: Country = await CountryList.getCountryByName(payload.ship_to.address.country);
    if (isEmpty(country))
      throw new ClientError({
        message: `Country ${payload.ship_to.address.country} not found. Cannot process order.`
      });
    const city: City = await USCities.getCityByName(payload.ship_to.address.city);
    if (isEmpty(city))
      throw new ClientError({
        message: `City ${payload.ship_to.address.city} not found. Cannot process order.`
      });

    logger.info('Checking account id and patient...');
    let recipient: User = await Users.getUserBy(account.account_id, 'email', payload.ship_to.email);

    if (!recipient) {
      logger.info('Patient not found. Creating new one...');
      const userData = {
        email: payload.ship_to.email,
        name: payload.ship_to.first_name,
        last_name: payload.ship_to.last_name,
        country_code: country.phonecode,
        phone_number: payload.ship_to.phone,
        user_role: 1
      };
      recipient = await Users.createUser(account.account_id, userData);
    }

    if (recipient?.account_id !== account.account_id)
      throw new ClientError({
        message: `The recipient with ${payload.ship_to.email} does not belong to account id ${account.account_id}. Cannot process order.`
      });

    if (!isEmpty(await Users.checkAlreadyExitsInAccount(account.account_id, recipient.email)))
      throw new ClientError({
        message: `The email ${recipient.email} is already linked to another account. Please try with a different email.`
      });

    // Notifying about reorder count
    if (!isEmpty(normalBundles)) {
      const bundlesReachedReorderCount: BundleProductReorderCount[] = getBundlesReachedReorderCount(normalBundles);
      if (!isEmpty(bundlesReachedReorderCount)) {
        logger.info('Notifying for reorder count...');
        for (const bundle of bundlesReachedReorderCount) {
          const replacements = {
            account_main_contact_name: account.name ?? '',
            text_choice_for_product_plural: WORD_MAP[globalSettings.default_word] || '',
            ecommerce_site_url: process.env.STORE_URL ?? '',
            app_name: globalSettings?.app_name ?? '',
            bundle_id: bundle.bundle_id,
            bundle_sku: bundle.bundle_sku,
            bundle_name: bundle.bundle_name,
            product_sku: bundle.product_sku,
            product_name: bundle.product_name,
            reorder_count: bundle.reorder_count,
            starting_units_on_hand: bundle.starting_units_on_hand
          };
          await enqueueEmail({
            messageId: account.messaging_id,
            templateId: 7,
            email: account.email,
            name: account.purchaser_name,
            relationId: bundle.bundle_id,
            replacements
          });
        }
      }
    }

    logger.info('Creating shipment recipient...');
    const shipmentRecipientData = {
      user_id: recipient.id,
      city_id: city?.id,
      state_id: city?.state_id,
      country_id: country?.id,
      first_name: payload.ship_to.first_name,
      last_name: payload.ship_to.last_name,
      email: payload.ship_to.email,
      phone: payload.ship_to.phone,
      street1: payload.ship_to.address.street_1,
      street2: payload.ship_to.address.street_2,
      postal_code: payload.ship_to.address.postal_code
    };
    const { insertId: shipmentRecipientId } = await ShipmentRecipients.createShipmentRecipient(shipmentRecipientData);

    // TODO: get support entity id from products
    const orderStatus = await Status.getStatusBy({
      language_id: 1,
      support_entity_id: 4,
      'STY.id': STAGE_TYPE.ORDER,
      'S.status_label': STATUSES.ORDER.PROCESSING
    });
    if (isEmpty(orderStatus))
      throw new ClientError({
        message: `Status '${STATUSES.ORDER.PROCESSING}' does not have mapping for support entity '4'.`
      });

    logger.info('Creating electronic order...');
    const orderData = {
      order_license_id: payload.ordering_entity_info.ordered_by_id,
      ordering_name: payload.ordering_entity_info.recipient_name,
      ordering_email: payload.ordering_entity_info.ordered_by_email,
      ordering_phone: payload.ordering_entity_info.ordered_by_phone,
      ordering_entity_name: payload.ordering_entity_info.ordered_by_entity_name,
      support_entity_id: account.support_entity_id,
      external_order_status_mapping_id: orderStatus.external_status_id,
      internal_order_status_mapping_id: orderStatus.internal_status_id,
      ordered_by_user_id: orderingUser.id
    };

    if (!isEmpty(orderingUser) && orderingUser.user_role === 7) {
      logger.info(`Provider found: ${orderingUser.id}. Adding to order.`);
      orderData.ordered_by_user_id = orderingUser.id;
      await Tasks.create({
        account_id: account.account_id,
        status: 1,
        task_message: `Provider with ID ${orderingUser.id} will get the test result first.`,
        task_type_id: 7,
        created_at: new Date()
      });

      // Ensure provider is attached to the account via UsersByAccountTable
      const userAccountLinker = await UsersByAccount.getBys({
        user_id: orderingUser.id,
        account_id: account.account_id
      });

      if (userAccountLinker) {
        const accountSettings = await Accounts.getById(account.account_id);
        const checkPatient = await Users.findUserbyNameorEmail(payload.ship_to.email, '');

        // Check if the account allows provider ordering
        if (accountSettings.enable_provider_ordering) {
          logger.info('Provider ordering is enabled for the account.');

          // Check if the provider can manage and add new patients
          if (userAccountLinker[0].permit_provider_add_and_manage_new_patients) {
            logger.info('Provider can add and manage new patients');

            // Check if the patient is already attached to another provider within this account
            if (checkPatient.length > 0 && userAccountLinker.length > 0) {
              const checkPatientAttachedToProvider = await PatientProviderLinker.getBys({
                patient_user_id: checkPatient[0].id
              });
              logger.debug('Checked patient attached to provider:', checkPatientAttachedToProvider);

              if (!checkPatientAttachedToProvider || checkPatientAttachedToProvider.length === 0) {
                const patientData = {
                  patient_account_linker_id: userAccountLinker[0].id,
                  patient_user_id: checkPatient[0].id,
                  provider_account_linker_id: userAccountLinker[0].id,
                  create_date: new Date()
                };
                await PatientProviderLinker.create(patientData);
                logger.info('Patient successfully linked to the provider.');
              }
            } else {
              logger.info('No patient or user account linker data found. Skipping linking process.');
            }
          }
        }
      }
    }

    const { insertId: orderId } = await Orders.create(orderData);

    logger.info('Creating user purchases...');
    const userPurchasesData = normalBundles.map((bundle: BundleWithProducts) => {
      const bundleRequest = payload.bundles.find(
        (requestBundle: BundleRequest) => requestBundle.sku === bundle.bundle_sku
      );
      return {
        bulk_shipping: Number(payload.order_type) == ORDER_TYPES_CODE.BULK_SHIPMENT ? 1 : 0,
        variations: bundleRequest?.flavor_id,
        account_id: account.account_id,
        electronic_order_id: orderId,
        user_id: orderingUser.id, // TODO: update ordering user id
        bundle_id: bundle.id,
        purchase_amt: 0,
        taxable_amt: 0,
        shipping_amt: 0,
        total_amt: 0,
        ...(bundleRequest?.flavor_id &&
          [FLAVOR_CODES.TEST_ONLY, FLAVOR_CODES.TEST_AND_EDUCATION].includes(bundleRequest?.flavor_id) && {
            purchased_tests: bundleRequest?.quantity || 1
          }),
        ...(bundleRequest?.flavor_id &&
          [FLAVOR_CODES.EDUCATION_ONLY, FLAVOR_CODES.TEST_AND_EDUCATION].includes(bundleRequest?.flavor_id) && {
            purchased_observations: bundleRequest?.quantity || 1
          })
      };
    });
    if (!isEmpty(userPurchasesData)) await UserPurchases.createUserPurchases(userPurchasesData);
    const userPurchaseDetails: UserPurchase[] = !isEmpty(userPurchasesData)
      ? await UserPurchases.getUserPurchases(orderId, account.account_id)
      : null;

    logger.info('Creating order bundle mapping...');
    const orderBundleMappingdata = normalBundles.map((bundle: BundleWithProducts) => {
      const bundleRequest = payload.bundles.find(
        (requestBundle: BundleRequest) => requestBundle.sku === bundle.bundle_sku
      );
      return {
        electronic_order_id: orderId,
        bundle_id: bundle.id,
        ...(bundleRequest?.diagnosis_code && {
          diagnosis_code: bundleRequest.diagnosis_code
        }),
        ...(bundleRequest?.billing_code && {
          billing_code: bundleRequest.billing_code
        }),
        ...(checkYesOrNoValue(bundleRequest?.submit_to_insurance) && {
          submit_to_insurance: 1
        })
      };
    });
    if (!isEmpty(orderBundleMappingdata)) await OrderBundleMapping.createOrderBundleMapping(orderBundleMappingdata);

    logger.info('Creating order event history...');
    const orderEventHistoryData = {
      electronic_order_id: orderId,
      external_status_mapping_id: orderStatus.external_status_id,
      internal_status_mapping_id: orderStatus.internal_status_id,
      status: orderStatus.internal_status
    };
    await OrderEventHistory.createOrderEventHistory(orderEventHistoryData);

    if (payload.custom_attributes) {
      logger.info('Creating user purchase attributes...');
      const attributes = Object.entries(payload.custom_attributes).map(([key, value]) => ({
        electronic_order_id: orderId,
        attribute_key: key,
        attribute_value: value
      }));
      await UserPurchasesAttributes.createUserPurchaseAttributes(attributes);
    }

    let bundlesWithTestAssignment: BundleWithTestAssignment[] = [];
    if (checkYesOrNoValue(payload.preassign_recipient_as_assignee) && !isEmpty(normalBundles)) {
      const assignedTo = recipient?.id;
      const dateTime = moment().format(DATE.LONG);

      logger.info('Creating test assignments for bundles...');
      testAssignmentData = normalBundles.map((bundle: BundleWithProducts) => {
        const userPurchase: UserPurchase | undefined = userPurchaseDetails.find(
          (userPurchase: UserPurchase) => userPurchase.bundle_id === bundle.id
        );
        const reqBundle = payload.bundles.find((reqBundle: BundleRequest) => reqBundle.sku === bundle.bundle_sku);
        return {
          user_purchase_id: userPurchase?.id,
          assigned_by: orderingUser?.id,
          assigned_to: assignedTo,
          assigned_datetime: dateTime,
          name: payload.ship_to.first_name,
          last_name: payload.ship_to.last_name,
          address: payload.ship_to.address.street_1,
          address2: payload.ship_to.address.street_2,
          city: payload.ship_to.address.city,
          postal: payload.ship_to.address.postal_code,
          state: payload.ship_to.address.region,
          country: payload.ship_to.address.country,
          bundle_id: bundle.id,
          recipient_type: 'adult',
          is_thrid_party_synced: 1,
          total_assigned_test:
            reqBundle?.flavor_id == FLAVOR_CODES.TEST_ONLY || reqBundle?.flavor_id == FLAVOR_CODES.TEST_AND_EDUCATION
              ? 1
              : null,
          total_assigned_observation:
            reqBundle?.flavor_id == FLAVOR_CODES.EDUCATION_ONLY ||
            reqBundle?.flavor_id == FLAVOR_CODES.TEST_AND_EDUCATION
              ? 1
              : null
          // TODO: Need to check fields below and from table
          // experience_by_account_id,
          // status: 0,
        };
      });
      await TestAssignments.createTestAssignments(testAssignmentData);

      const newAssignments: TestAssignment[] = await TestAssignments.getTestAssignments(assignedTo, dateTime);
      bundlesWithTestAssignment = newAssignments.map((assignment: TestAssignment) => {
        const bundle = bundles.find((bundle: BundleWithProducts) => bundle.id === assignment.bundle_id);
        return {
          quantity: 1,
          assignment_id: assignment.id,
          bundle_sku: bundle?.bundle_sku,
          created_at: assignment.created_at
        };
      });
      const testAssigmentObsevationLinkerData = bundles.map((bundle: BundleWithProducts) => {
        const assignmentId = newAssignments.find(
          (assignment: TestAssignment) => assignment.bundle_id === bundle.id
        )?.id;
        return {
          test_assignment_id: assignmentId,
          experiences_by_account_id: account.account_id,
          bundle_id: bundle.id,
          status: 0,
          order_by: 1
        };
      });
      await TestAssigmentObsevationLinker.bulkCreate(testAssigmentObsevationLinkerData);
    }

    const reqExperienceNames: string[] = normalBundles.map(
      (bundle: BundleWithProducts) => `${bundle.bundle_name} for ${account.name} for (Ele)`
    );
    const experiencesDetails: Experience[] =
      await ExperiencesByAccount.getExperienceByAccountByNames(reqExperienceNames);
    const newExperienceNames: string[] = reqExperienceNames.filter(
      (name: string) => !experiencesDetails.some((exp: Experience) => exp.name === name)
    );

    if (!isEmpty(newExperienceNames)) {
      logger.info('Creating new experiences by account...');
      const experiencesData = newExperienceNames.map((name: string) => ({
        account_id: account.account_id,
        name: name,
        sla_time: account.sla_time,
        type: 2
      }));
      await ExperiencesByAccount.createExperienceByAccountForAnOrder(experiencesData);

      const newBundleExperiences: Experience[] =
        await ExperiencesByAccount.getExperienceByAccountByNames(newExperienceNames);
      const allBundlesWithExperienceDetails: ExperienceWithBundle[] = newBundleExperiences.map(
        (experience: Experience) => {
          const bundle = normalBundles.find(
            (bundle: BundleWithProducts) => `${bundle.bundle_name} for ${account.name} for (Ele)` === experience.name
          );
          return { experience_id: experience.id, bundle_id: bundle?.id };
        }
      );

      const uniqueProducts: Product[] = getUniqueProductsFromBundles(bundles);
      const observationFlows: ObservationFlowProduct[] =
        await ObservationFlowLinkerProduct.getObservationFlowsByProductIds(
          uniqueProducts.map((product: Product) => product.product_id)
        );
      const experiencesByAccountFlowLinkerData: ExperienceByAccountFlowLinker[] = [];
      normalBundles.forEach((bundle: BundleWithProducts) => {
        bundle.products.forEach((product: Product, index: number) => {
          const experience = allBundlesWithExperienceDetails.find(
            (item: ExperienceWithBundle) => item.bundle_id === bundle.id
          );
          const observationFlow = observationFlows.find(
            (item: ObservationFlowProduct) => item.id === product.product_id
          );
          experiencesByAccountFlowLinkerData.push({
            product_id: product.product_id,
            bundle_id: bundle.id,
            experiences_by_account_id: experience?.experience_id,
            order_by: index + 1,
            observation_flow_id: observationFlow?.observation_flow_id,
            default_exp_bundle: 0
          });
        });
      });

      logger.info('Creating new experiences by account flow linker...');
      await ExperiencesByAccountFlowLinker.createExperienceByAccountFlowLinker(experiencesByAccountFlowLinkerData);
    }

    logger.info('Updating product starting units...');
    await Promise.all(
      normalBundles.map(async (bundle: BundleWithProducts) => {
        const productIds = bundle.products.map((product: Product) => product.id);
        const reqBundle = payload.bundles.find((reqBundle: BundleRequest) => reqBundle.sku === bundle.bundle_sku);
        const orderredBundleQty = reqBundle?.quantity || 1;

        const userPurchasebundleQty = await UserPurchases.getBundleQty(account.account_id, bundle.id);
        const bundleConsumed = await UserConsumedTestsObservations.getUserConsumedTests(account.account_id, bundle.id);
        const provisionedQty =
          parseInt(userPurchasebundleQty.total_units || 0) - parseInt(bundleConsumed.shipped_tests || 0);

        if (account.acc_permit_ad_hoc_ordering && account.draw_from_provisioned_orders)
          if (provisionedQty < orderredBundleQty) {
            const remainingQuantity = orderredBundleQty - provisionedQty;
            await Products.updateProductsStartingUnits(productIds, remainingQuantity);
            await updateBunldeQuantity(account.account_id, bundle.id, reqBundle?.flavor_id, provisionedQty);
          } else {
            const remainingQuantity = provisionedQty - orderredBundleQty;
            await updateBunldeQuantity(account.account_id, bundle.id, reqBundle?.flavor_id, remainingQuantity);
          }
        await updateBunldeQuantity(account.account_id, bundle.id, reqBundle?.flavor_id, orderredBundleQty);
      })
    );

    const shipmentStatus = await Status.getStatusBy({
      language_id: 1,
      support_entity_id: 4,
      'STY.id': STAGE_TYPE.SHIPMENT,
      'S.status_label': STATUSES.SHIPMENT.PROCESSING
    });
    if (isEmpty(shipmentStatus))
      throw new ClientError({
        message: `Status '${STATUSES.SHIPMENT.PROCESSING}' does not have mapping for support entity '4'.`
      });
    const carrierCode: CarrierCode = await CarrierCodes.getCarrierById(globalSettings.default_domestic_carrier);

    /**
     * Inbound Shipments
     */
    let inboundShipmentsAndLineItems: ShipmentAndLineItems[] = getShipmentsAndLineItems({
      globalSettings,
      controlledCatalogSupportEntityIds: accountsControllingSupportEntityCatalogsIds,
      bundles: normalBundles,
      shipmentRecipientId,
      status: shipmentStatus,
      orderId,
      assignmentDetails: bundlesWithTestAssignment
    });
    let inboundShipments: Shipment[] = [];
    if (!isEmpty(inboundShipmentsAndLineItems)) {
      // Filter out the line items from inboundShipmentsAndLineItems based on userSelectedBundeIds
      inboundShipmentsAndLineItems = inboundShipmentsAndLineItems
        .map(shipment => ({
          ...shipment,
          line_items: shipment.line_items.filter((lineItem: LineItem) => lineItem.user_selected_bundle)
        }))
        .filter(shipment => !isEmpty(shipment.line_items));
    }

    logger.info('Creating inbound shipments...');
    const inboundShipmentInsert = !isEmpty(inboundShipmentsAndLineItems)
      ? await Shipments.createShipments(
          inboundShipmentsAndLineItems.map((shipment: ShipmentAndLineItems) => ({
            ...omit(shipment, 'line_items')
          }))
        )
      : null;
    if (inboundShipmentInsert?.affectedRows > 0) {
      // all inbound shipments
      inboundShipments = await Shipments.getShipmentsBy(
        'external_id',
        inboundShipmentsAndLineItems.map((shipment: ShipmentAndLineItems) => shipment.external_id)
      );
      inboundShipmentsAndLineItems = inboundShipmentsAndLineItems.map((shipment: ShipmentAndLineItems) => {
        const inboundShipment = inboundShipments.find(
          (shipmentWithID: Shipment) => shipmentWithID.external_id === shipment.external_id
        );
        return {
          id: inboundShipment?.id,
          ...shipment
        };
      });

      // create shipment products mapping
      logger.info('Creating inbound shipment products mapping...');
      const inboundShipmentProductsMappingData = inboundShipmentsAndLineItems.flatMap(
        (shipment: ShipmentAndLineItems) => {
          const inboundShipment = inboundShipments.find(
            (shipmentWithID: Shipment) => shipmentWithID.external_id === shipment.external_id
          );
          return shipment.line_items.flatMap((lineItem: LineItem) =>
            lineItem.products.map((product: LineItemProduct) => ({
              shipment_id: inboundShipment?.id,
              bundle_id: lineItem.bundle_id,
              product_id: product.product_id,
              order_id: lineItem.order_id,
              shipment_test_assignment_id: lineItem.shipment_test_assignment_id || null,
              line_item_type: lineItem.line_item_type
            }))
          );
        }
      );

      await ShipmentProductsMapping.createShipmentProductsMapping(inboundShipmentProductsMappingData);

      // creating shipment event history
      logger.info('Creating inbound shipment event history...');
      const shipmentEventHistoryData = inboundShipments.map((shipment: Shipment) => ({
        shipment_id: shipment.id,
        external_status_mapping_id: shipmentStatus.external_status_id,
        internal_status_mapping_id: shipmentStatus.internal_status_id,
        status: shipmentStatus.internal_status
      }));
      await ShipmentEventHistory.createShipmentsEventHistory(shipmentEventHistoryData);
      const inboundSupportEntitiesWithCredentials: SupportEntityCredentialsType[] =
        await SupportEntity.getSupportEntityConnectorWithCredentialsByIdIn(
          inboundShipmentsAndLineItems.map((is: ShipmentAndLineItems) => is.support_entity_id)
        );
      if (isEmpty(inboundSupportEntitiesWithCredentials))
        throw new ClientError({
          message: 'No connector or custom configuration found for Warehouse'
        });

      if (globalSettings.enable_inbound_shipping_label_creation) {
        for (const shipment of inboundShipmentsAndLineItems) {
          const supportEntityDetails = inboundSupportEntitiesWithCredentials.find(
            (item: SupportEntityCredentialsType) => item.id == shipment.support_entity_id
          );
          const inboundShipmentLabelData = {
            shipment: {
              carrier_id: carrierCode.carrier_id,
              service_code: globalSettings.default_domestic_priority,
              external_order_id: ORDER_CREATION_KEY ? `${ORDER_CREATION_KEY}-${orderId}` : orderId,
              external_shipment_id: ORDER_CREATION_KEY ? `${ORDER_CREATION_KEY}-${shipment.id}` : shipment.id,
              ship_from: {
                name: `${payload?.ship_to?.first_name} ${payload?.ship_to?.last_name}`,
                phone: payload?.ship_to?.phone,
                address_line1: payload?.ship_to?.address?.street_1,
                city_locality: payload?.ship_to?.address?.city,
                state_province: payload?.ship_to?.address?.region,
                postal_code: payload?.ship_to?.address?.postal_code,
                country_code: payload?.ship_to?.address?.country,
                address_residential_indicator: 'no'
              },
              ship_to: {
                name: supportEntityDetails?.entity_contact_name,
                phone: supportEntityDetails?.entity_contact_phone,
                address_line1: supportEntityDetails?.entity_contact_address,
                city_locality: supportEntityDetails?.entity_contact_city,
                state_province: supportEntityDetails?.entity_contact_state,
                postal_code: supportEntityDetails?.entity_contact_zip,
                country_code: supportEntityDetails?.entity_contact_country_code,
                address_residential_indicator: 'no'
              },
              packages: [
                {
                  weight: {
                    value: shipment.line_items.reduce((acc: number, item: LineItem) => acc + item.weight, 0),
                    unit: shipment.line_items.find((item: LineItem) => item.weight_unit)?.weight_unit
                  }
                }
              ],
              is_return: false,
              customs: null
            },
            charge_event: 'carrier_default',
            validate_address: 'validate_and_clean',
            label_download_type: 'url',
            label_format: 'pdf',
            display_scheme: 'label',
            label_layout: '4x6'
          };
          const shipmentLabel = await Shipengine.createLabel(inboundShipmentLabelData);
          logger.info('Updating the inbound shipment tracking and label urls');
          await Shipments.update(
            {
              carrier_codes_id: carrierCode.id,
              carrier_code: globalSettings.default_domestic_priority,
              shipment_tracking_id: shipmentLabel?.tracking_number,
              tracking_url: shipmentLabel?.tracking_url,
              shipping_label_url: shipmentLabel?.label_download?.pdf
            },
            { id: shipment.id }
          );
        }
      }
    }

    /**
     * outbound Shipments
     */
    let externalOrderId: string = '';
    let outboundShipmentsAndLineItems: ShipmentAndLineItems[] = getShipmentsAndLineItems({
      globalSettings,
      controlledCatalogSupportEntityIds: accountsControllingSupportEntityCatalogsIds,
      bundles: normalBundles,
      shipmentRecipientId,
      status: shipmentStatus,
      orderId,
      assignmentDetails: bundlesWithTestAssignment,
      inbound: false
    });

    // Wallet and Ledger Creation
    await createOutShipmentWalletAndLedger(
      payload,
      userSelectedBundleLists,
      globalSettings,
      accountsControllingSupportEntityCatalogsIds,
      account.account_id,
      recipient.id
    );

    // Filter out the line items from outboundShipmentsAndLineItems based on userSelectedBundeIds
    outboundShipmentsAndLineItems = outboundShipmentsAndLineItems
      .map(shipment => ({
        ...shipment,
        line_items: shipment.line_items.filter((lineItem: LineItem) => !lineItem.user_selected_bundle)
      }))
      .filter(shipment => !isEmpty(shipment.line_items));

    if (!isEmpty(outboundShipmentsAndLineItems)) {
      logger.info('Creating the outbound shipments...');
      const outboundShipmentInsert = await Shipments.createShipments(
        outboundShipmentsAndLineItems.map((shipment: ShipmentAndLineItems) => ({
          ...omit(shipment, 'line_items')
        }))
      );
      if (outboundShipmentInsert?.affectedRows > 0) {
        const outboundShipmentIds: number[] = getNumberArray(
          outboundShipmentInsert.insertId,
          outboundShipmentInsert.affectedRows
        );

        // inbound outbound shipments mapping
        logger.info('Creating inbound outbound shipment mapping...');
        await ShipmentOutboundMapping.createShipmentOutboundMapping(
          outboundShipmentIds,
          inboundShipments?.map((s: Shipment) => s.id)
        );

        // all outbound shipments
        const outboundShipments = await Shipments.getShipments(outboundShipmentIds);
        outboundShipmentsAndLineItems = outboundShipmentsAndLineItems.map((shipment: ShipmentAndLineItems) => {
          const outboundShipment = outboundShipments.find(
            (shipmentWithID: Shipment) => shipmentWithID.external_id === shipment.external_id
          );
          return {
            id: outboundShipment?.id,
            ...shipment
          };
        });

        // create shipment products mapping
        logger.info('Creating outbound shipment products mapping...');
        const outboundShipmentProductsMappingData = outboundShipmentsAndLineItems.flatMap(
          (shipment: ShipmentAndLineItems) => {
            return shipment.line_items.flatMap((lineItem: LineItem) =>
              lineItem.products.map((product: LineItemProduct) => ({
                shipment_id: shipment?.id,
                bundle_id: lineItem.bundle_id,
                product_id: product.product_id,
                order_id: lineItem.order_id,
                shipment_test_assignment_id: lineItem.shipment_test_assignment_id || null,
                line_item_type: lineItem.line_item_type
              }))
            );
          }
        );
        await ShipmentProductsMapping.createShipmentProductsMapping(outboundShipmentProductsMappingData);

        // creating shipment event history
        logger.info('Creating outbound shipment event history...');
        const shipmentEventHistoryData = outboundShipments.map((shipment: Shipment) => ({
          shipment_id: shipment.id,
          external_status_mapping_id: shipmentStatus.external_status_id,
          internal_status_mapping_id: shipmentStatus.internal_status_id,
          status: shipmentStatus.internal_status
        }));
        await ShipmentEventHistory.createShipmentsEventHistory(shipmentEventHistoryData);
      }

      const outboundSupportEntitiesWithCredentials = await SupportEntity.getSupportEntityConnectorWithCredentialsByIdIn(
        outboundShipmentsAndLineItems.map((is: ShipmentAndLineItems) => is.support_entity_id)
      );
      if (isEmpty(outboundSupportEntitiesWithCredentials))
        throw new ClientError({
          message: 'No connector or custom configuration found for Warehouse'
        });

      // creating outbound order
      if (!['Y', 'Yes', 'yes', 'y'].includes(payload.external_shipment_information?.shipment_handled_externally)) {
        const orderNumber = ORDER_CREATION_KEY ? `${ORDER_CREATION_KEY}-${orderId}` : orderId;
        const shippingAddress = {
          first_name: payload.ship_to.first_name,
          last_name: payload.ship_to.last_name,
          email: payload.ship_to.email,
          phone: payload.ship_to.phone,
          address1: payload.ship_to.address.street_1,
          address2: payload.ship_to.address.street_2,
          city: payload.ship_to.address.city,
          state: payload.ship_to.address.region,
          zip: payload.ship_to.address.postal_code,
          country: payload.ship_to.address.country
        };
        const lineItems = outboundShipmentsAndLineItems
          .map((shipment: ShipmentAndLineItems) =>
            shipment.line_items.map((item: LineItem) => ({
              sku: item.bundle_sku,
              partner_line_item_id: `${orderNumber}-${item.bundle_id}`,
              quantity: item.quantity,
              price: `${item.bundle_price}`,
              product_name: item.bundle_name,
              fulfillment_status: 'pending',
              quantity_pending_fulfillment: item.quantity,
              warehouse_id: outboundSupportEntitiesWithCredentials.find(
                (entity: SupportEntityCredentialsType) => entity.id === shipment.support_entity_id
              )?.external_id
            }))
          )
          .flat();
        const orderResponse = await Shiphero.createOrder({
          orderNumber,
          shippingAddress,
          lineItems
        });
        externalOrderId = orderResponse?.data?.order_create?.order?.id;
        const shipheroLineItems = orderResponse?.data?.order_create?.order?.line_items?.edges?.map((item: any) => ({
          line_item_id: item.node.id,
          quantity: item.node.quantity
        }));
        logger.info('Updating the order external id...');
        await Orders.updateOrderExternalId(orderId, externalOrderId);

        // Create third party orders with shipHero
        await Promise.all(
          normalBundles.map(async (bundle: BundleWithProducts) => {
            // third party orders creation
            const thirdPartyOrderData = {
              bundle_id: bundle.id,
              support_entity_id: account.support_entity_id,
              third_party_order_id: externalOrderId,
              third_party_order_type: 'shiphero',
              third_party_order_status: orderStatus.internal_status,
              third_party_order_status_mapping_id: orderStatus.external_status_id,
              third_party_order_full_response: JSON.stringify(orderResponse),
              electronic_order_id: orderId
            };
            await ThirdPartyOrders.create(thirdPartyOrderData);
          })
        );

        // crelio patient registration and order creation
        logger.info('Creating order on crelio...');
        await createCrelioOrderWithPatientRegistration(
          account,
          normalBundles,
          recipient,
          payload.ship_to,
          orderId,
          orderStatus.external_status_id
        );

        // MyBabBox order creation
        await createMyLabBoxOrder(orderId, recipient, payload.ship_to, normalBundles);

        // create shipping labels for each shipment
        for (const shipment of outboundShipmentsAndLineItems) {
          const supportEntityDetails = outboundSupportEntitiesWithCredentials.find(
            (item: SupportEntityCredentialsType) => item.id == shipment.support_entity_id
          );

          // creating outbound shipment label
          let shipmentLabel;
          if (globalSettings.enable_outbound_shipping_label_creation) {
            const shipmentLabelData = {
              shipment: {
                carrier_id: carrierCode.carrier_id,
                service_code: globalSettings.default_domestic_priority,
                external_order_id: ORDER_CREATION_KEY ? `${ORDER_CREATION_KEY}-${orderId}` : orderId,
                external_shipment_id: ORDER_CREATION_KEY ? `${ORDER_CREATION_KEY}-${shipment.id}` : shipment.id,
                ship_from: {
                  name: supportEntityDetails?.entity_contact_name,
                  phone: supportEntityDetails?.entity_contact_phone,
                  address_line1: supportEntityDetails?.entity_contact_address,
                  city_locality: supportEntityDetails?.entity_contact_city,
                  state_province: supportEntityDetails?.entity_contact_state,
                  postal_code: supportEntityDetails?.entity_contact_zip,
                  country_code: supportEntityDetails?.entity_contact_country_code,
                  address_residential_indicator: 'no'
                },
                ship_to: {
                  name: `${payload?.ship_to?.first_name} ${payload?.ship_to?.last_name}`,
                  phone: payload?.ship_to?.phone,
                  address_line1: payload?.ship_to?.address?.street_1,
                  city_locality: payload?.ship_to?.address?.city,
                  state_province: payload?.ship_to?.address?.region,
                  postal_code: payload?.ship_to?.address?.postal_code,
                  country_code: payload?.ship_to?.address?.country,
                  address_residential_indicator: 'yes'
                },
                packages: [
                  {
                    weight: {
                      value: shipment.line_items.reduce((acc: number, item: LineItem) => acc + item.weight, 0),
                      unit: shipment.line_items.find((item: LineItem) => item.weight_unit)?.weight_unit
                    }
                  }
                ]
              },
              charge_event: 'carrier_default',
              validate_address: 'validate_and_clean',
              label_download_type: 'url',
              label_format: 'pdf',
              display_scheme: 'label',
              label_layout: '4x6'
            };
            shipmentLabel = await Shipengine.createLabel(shipmentLabelData);
            logger.info('Updating the outbound shipment tracking and label urls...');
            await Shipments.update(
              {
                carrier_codes_id: carrierCode.id,
                carrier_code: globalSettings.default_domestic_priority,
                shipment_tracking_id: shipmentLabel?.tracking_number,
                tracking_url: shipmentLabel?.tracking_url,
                shipping_label_url: shipmentLabel?.label_download?.pdf
              },
              { id: shipment.id }
            );
          }

          if (
            globalSettings.permit_personalized_shipment_inserts &&
            account.enable_personalized_shipment_inserts &&
            supportEntityDetails.permit_personalized_shipment_inserts
          ) {
            if (!supportEntityDetails.support_personalized_shipment_inserts)
              logger.info('Support entity does not support personalized shipment inserts');
            else {
              logger.info('Initiating personalized shipment insert...');
              // Personalized shipment inserts
              await QRCodePDFCreation({
                account_id: request.account.account_id,
                user: recipient,
                shipment_id: shipment.id
              });
            }
          }

          // creating outbound shipment
          const labelAddress = {
            name: `${shippingAddress.first_name} ${shippingAddress.last_name}`,
            address1: shippingAddress.address1,
            address2: shippingAddress.address2,
            city: shippingAddress.city,
            state: shippingAddress.state,
            zip: shippingAddress.zip,
            country: shippingAddress.country,
            phone: shippingAddress.phone
          };
          const trackingNumber = shipmentLabel?.tracking_number || '';
          const labelUrl = shipmentLabel?.label_download.pdf || '';
          const labelsData = {
            address: labelAddress,
            carrier: 'ground',
            shipping_name: 'Ground',
            shipping_method: 'ground',
            cost: `${shipment.line_items.reduce((acc: number, item: LineItem) => acc + (item.bundle_price || 0), 0)}`,
            dimensions: { weight: '0', height: '0', width: '0', length: '0' },
            label: {
              paper_pdf_location: labelUrl,
              thermal_pdf_location: labelUrl,
              pdf_location: labelUrl
            },
            line_item_ids: shipheroLineItems.map((l: any) => l.line_item_id).join(','),
            tracking_number: trackingNumber
          };

          const shipementResponse = await Shiphero.createShipment({
            orderId: externalOrderId,
            warehouseId: supportEntityDetails?.external_id,
            address: labelAddress,
            lineItems: shipheroLineItems,
            labels: labelsData
          });
          const shipheroShipmentId = shipementResponse?.data?.shipment_create?.shipment?.id;
          if (shipment.id && externalOrderId) {
            logger.info('Updating the outbound shipment external id...');
            await Shipments.updateExternalId(shipment.id, shipheroShipmentId);
          }
        }

        for (const bundle of payload.bundles) {
          const messagingTypeId = getMessageTypeIdByFlavor(Number(payload.order_type), bundle.flavor_id);

          // replace template variables
          const replacements = {
            account_main_contact_name: account.name,
            app_name: globalSettings?.app_name ?? '',
            user_login_id: recipient.email,
            user_login_pass: '',
            login_url: `${process.env.PHP_URL}/purchaser`,
            customer_name: `${payload.ship_to.first_name} ${payload.ship_to.last_name}`,
            order_id: externalOrderId,
            order_type: payload.order_type,
            customer_email: payload.ship_to.email,
            entity_name: payload.ordering_entity_info.ordered_by_entity_name,
            phone_number: payload.ship_to.phone,
            bundles: payload.bundles,
            first_name: payload.ship_to.first_name,
            last_name: payload.ship_to.last_name,
            email: payload.ship_to.email,
            phone: payload.ship_to.phone,
            address: payload.ship_to.address
          };
          await enqueueEmail({
            messageId: account.messaging_id,
            templateId: messagingTypeId,
            email: payload.ship_to.email,
            name: `${payload.ship_to.first_name} ${payload.ship_to.last_name}`,
            relationId: orderId,
            replacements
          });
        }
      }

      if (['Y', 'Yes', 'yes', 'y'].includes(payload.external_shipment_information?.shipment_handled_externally)) {
        // get status data

        const shipmentStatus = await Status.getStatusBy({
          language_id: 1,
          support_entity_id: 4,
          'STY.id': STAGE_TYPE.SHIPMENT,
          'S.status_label': payload.starting_order_status
        });
        if (isEmpty(shipmentStatus))
          throw new ClientError({
            message: `Status '${payload.starting_order_status}' does not have mapping for support entity '4'.`
          });

        // get carrier code id with external carrier id
        const shipmentCarrierMapping = await ShipmentCarrierMapping.getBy(
          'external_carrier',
          payload.external_shipment_information.carrier_id
        );
        if (isEmpty(shipmentCarrierMapping))
          throw new ClientError({
            message: `You provided a carrier id (${payload.external_shipment_information.carrier_id}) which is not mapped to our carriers. Cannot proceed.`
          });

        for (const shipment of outboundShipmentsAndLineItems) {
          //Update shipment records if its handled externally
          await Shipments.update(
            {
              shipment_carrier_mapping_id: shipmentCarrierMapping.id,
              carrier_codes_id: shipmentCarrierMapping.internal_carrier_id,
              updated_at: new Date(),
              shipment_tracking_id: payload.external_shipment_information.tracking_id,
              status: shipmentStatus.internal_status,
              internal_shipment_status_mapping_id: shipmentStatus.internal_status_id,
              external_shipment_status_mapping_id: shipmentStatus.external_status_id
            },
            { id: shipment.id }
          );

          // add shipment event history
          const shipmentEventHistoryData = [
            {
              shipment_id: shipment.id,
              external_status_mapping_id: shipmentStatus.external_status_id,
              internal_status_mapping_id: shipmentStatus.internal_status_id,
              status: payload.starting_order_status
            }
          ];
          await ShipmentEventHistory.createShipmentsEventHistory(shipmentEventHistoryData);
        }

        // update order status
        const orderUpdate = {
          updated_at: new Date(),
          internal_order_status_mapping_id: shipmentStatus.internal_status_id,
          external_order_status_mapping_id: shipmentStatus.external_status_id
        };
        await Orders.update(orderUpdate, { id: orderId });

        // add order event history
        const orderEventHistoryData = {
          order_id: orderId,
          external_order_status_mapping_id: shipmentStatus.external_status_id,
          internal_order_status_mapping_id: shipmentStatus.internal_status_id,
          status: payload.starting_order_status
        };
        await OrderEventHistory.createOrderEventHistory(orderEventHistoryData);
      }
    }

    const address = payload.ship_to.address;
    if (userPurchaseDetails?.some((userPurchase: UserPurchase) => userPurchase.bulk_shipping === 1)) {
      // bulk shipment
      if (isEmpty(address)) {
        const replacements = {
          assignee_first_name: recipient.name,
          assignee_last_name: recipient.last_name,
          assignee_name: recipient.name,
          text_choice_for_product_singular: WORD_MAP[globalSettings.default_word] || '',
          account_main_contact_name: account.name
        };
        await enqueueEmail({
          messageId: account.messaging_id,
          templateId: 18,
          email: recipient.email,
          name: `${recipient.name} ${recipient.last_name}`,
          relationId: orderId,
          replacements
        });
      }
    }
    if (userPurchaseDetails?.some((userPurchase: UserPurchase) => userPurchase.bulk_shipping !== 1)) {
      // individual shipment
      if (isEmpty(address)) {
        if (
          payload.bundles.some(
            (bundle: BundleRequest) =>
              bundle.flavor_id === FLAVOR_CODES.TEST_AND_EDUCATION || bundle.flavor_id === FLAVOR_CODES.TEST_ONLY
          )
        ) {
          const replacements = {
            assignee_first_name: recipient.name,
            assignee_last_name: recipient.last_name,
            purchaser_name: account.purchaser_name,
            // update_address_link
            assignee_name: recipient.name,
            text_choice_for_product_singular: WORD_MAP[globalSettings.default_word] || '',
            account_main_contact_name: account.name
          };
          await enqueueEmail({
            messageId: account.messaging_id,
            templateId: 18,
            email: recipient.email,
            name: `${recipient.name} ${recipient.last_name}`,
            relationId: orderId,
            replacements
          });
        }
      }
    }
    if (checkYesOrNoValue(payload.preassign_recipient_as_assignee)) {
      if (userPurchaseDetails?.some((userPurchase: UserPurchase) => userPurchase.bulk_shipping === 1)) {
        // bulk shipment
        const educationOnlyBundles = payload.bundles.some(
          (bundle: BundleRequest) => bundle.flavor_id === FLAVOR_CODES.EDUCATION_ONLY
        );
        if (educationOnlyBundles) {
          const replacements = {
            assignee_first_name: recipient.name,
            assignee_last_name: recipient.last_name,
            purchaser_name: account.purchaser_name,
            assignee_name: recipient.name,
            account_main_contact_name: account.name,
            text_choice_for_product_singular: WORD_MAP[globalSettings.default_word] || ''
          };
          await enqueueEmail({
            messageId: account.messaging_id,
            templateId: 14,
            email: recipient.email,
            name: `${recipient.name} ${recipient.last_name}`,
            relationId: orderId,
            replacements
          });
        }
        // TODO: Add delayed notification date logic
      }
      if (userPurchaseDetails?.some((userPurchase: UserPurchase) => userPurchase.bulk_shipping !== 1)) {
        // individual shipment
        const educationOnlyBundles = payload.bundles.some(
          (bundle: BundleRequest) => bundle.flavor_id === FLAVOR_CODES.EDUCATION_ONLY
        );
        const otherBundles = payload.bundles.some((bundle: BundleRequest) =>
          Object.values(FLAVOR_CODES).includes(bundle.flavor_id)
        );
        if (educationOnlyBundles && otherBundles) {
          const replacements = {
            assignee_first_name: recipient.name,
            assignee_last_name: recipient.last_name,
            purchaser_name: account.purchaser_name,
            assignee_name: recipient.name,
            account_main_contact_name: account.name,
            text_choice_for_product_singular: WORD_MAP[globalSettings.default_word] || ''
          };
          await enqueueEmail({
            messageId: account.messaging_id,
            templateId: 16,
            email: recipient.email,
            name: `${recipient.name} ${recipient.last_name}`,
            relationId: orderId,
            replacements
          });
        }
      }
    }

    const webHookData = {
      account_id: account.account_id,
      stage_type_id: STAGE_TYPE.ORDER,
      support_entity_id: account.support_entity_id,
      relation_id: orderId,
      status_name: orderStatus.internal_status,
      is_sent: 0
    };

    // For sending status via outbound push on order creation
    logger.info('Enqueuing the outbound webhook...');
    await OutboundWebhookQueue.enqueueOutboundWebhook(webHookData);

    // trigger logic based on the conditions ..

    logger.info('triggered last interaction record based on the conditions...');

    const productTypes = new Set<number>();
    let productCount = 0;

    normalBundles.forEach((bundle: BundleWithProducts) => {
      if (bundle?.products?.length > 0) {
        productCount += bundle.products.length;
        bundle.products.forEach((product: Product) => {
          productTypes.add(product.type);
        });
      }
    });
    // here updating the test Assignment data alos updating the shipment_id
    if (checkYesOrNoValue(payload.preassign_recipient_as_assignee)) {
      const updatedTestAssignments = testAssignmentData.map(assignment => {
        const shipment = outboundShipmentsAndLineItems.find(shipment =>
          shipment.line_items.some(item => item.bundle_id === assignment.bundle_id)
        );
        return {
          ...assignment,
          shipment_id: shipment ? shipment.external_id : null
        };
      });
      const shipmentIds = await Promise.all(
        updatedTestAssignments.map(async assignment => {
          const shipment = assignment.shipment_id ? await Shipments.getBy('external_id', assignment.shipment_id) : null;

          return {
            ...assignment,
            shipment_id: shipment ? shipment.id : null
          };
        })
      );
      await Promise.all(
        shipmentIds.map(async assignment =>
          TestAssignments.update(
            { shipment_id: assignment.shipment_id },
            { user_purchase_id: assignment.user_purchase_id },
            true
          )
        )
      );
    }

    const checkPatient = await Users.findUserbyNameorEmail(payload.ship_to.email, '');
    if (!isEmpty(checkPatient)) {
      // Fetch patient_provider_linker_id if user details exist
      const patientProviderDetail: PatientProviderLinkerType = await PatientProviderLinker.getBy(
        'patient_user_id',
        checkPatient[0].id
      );
      if (patientProviderDetail) {
        const patient_provider_linker_id = patientProviderDetail?.id;
        // interaction type based on product types
        const productTypeCount = productTypes?.size;

        if (productTypeCount > 1) {
          // trigger for multiple product types
          await callTriggerMethodToInsertTheLastInteractionRecord(
            INTERACTION_TYPES.ORDERED_MULTIPLE_PRODUCT_TYPES,
            productCount,
            patient_provider_linker_id,
            INTERACTION_TYPES_MAPPED.ORDERED_MULTIPLE_PRODUCT_TYPES
          );
        } else if (productTypeCount === 1) {
          // trigger for a single product type
          const value = Array.from(productTypes)[0];
          const interactionType = value === 1 ? INTERACTION_TYPES.ORDERED_TESTS : INTERACTION_TYPES.ORDERED_DEVICES;
          const mappedType =
            value === 1 ? INTERACTION_TYPES_MAPPED.ORDERED_TESTS : INTERACTION_TYPES_MAPPED.ORDERED_DEVICES;

          await callTriggerMethodToInsertTheLastInteractionRecord(
            interactionType,
            productCount,
            patient_provider_linker_id,
            mappedType
          );
        }
      }
    }

    const customerWallet = await CustomerWallet.getBy('user_id', recipient?.id);
    let selectorURL: string = '';
    if (!isEmpty(userSelectedBundleLists)) {
      selectorURL = await createSelectorURL(
        account?.account_id,
        recipient?.id,
        orderId,
        userSelectedBundleLists.map((list: UserSelectedBundleListsType) => list.id),
        payload.ship_to
      );
    }
    for (const usb of userSelectedBundleLists) {
      if (usb.notify_recipient_after_user_selected_bundle_ordered_api === 1) {
        const replacements = {
          app_name: globalSettings?.app_name ?? '',
          user_name: `${payload.ship_to.first_name} ${payload.ship_to.last_name}`,
          selector_url: selectorURL
        };
        const emailTemplate: MessageTemplate = await MessageTemplates.getEmailMessageTemplate(
          account.messaging_id,
          118
        );
        const { subject } = emailTemplate;
        const emailData = await EmailQueue.getBys({
          subject,
          relation_id: orderId
        });
        if (isEmpty(emailData)) {
          await enqueueEmail({
            messageId: account.messaging_id,
            templateId: 118,
            email: payload.ship_to.email,
            name: `${payload.ship_to.first_name} ${payload.ship_to.last_name}`,
            relationId: orderId,
            replacements
          });
        }
      }
    }
    if (!isEmpty(userSelectedBundleLists)) {
      const globalSettings: GlobalSetting = await GlobalSettings.getGlobalSettings();

      // **Reminder Logic**
      const replacements = {
        user_name: `${payload.ship_to.first_name} ${payload.ship_to.last_name}`,
        selector_url: selectorURL,
        app_name: globalSettings?.app_name ?? ''
      };
      console.log('Reminder replacements:', replacements);
      // await reminderNotification(
      //   account.messaging_id,
      //   119,
      //   payload.ship_to.email,
      //   `${payload.ship_to.first_name} ${payload.ship_to.last_name}`,
      //   orderId,
      //   replacements
      // );
    }

    logger.info('Order creation completed!!!');
    await DB.commit();

    const data = {
      order: {
        gdt_id: orderId,
        ...(externalOrderId && {
          external_id: externalOrderId
        })
      },
      account_id: {
        external_id: request.account.external_account_id,
        gdt_id: request.account.account_id
      },
      status: orderStatus.internal_status,
      preassign_recipient_as_assignee: payload.preassign_recipient_as_assignee,
      order_type: payload.order_type,
      bundles: payload.bundles,
      ordering_entity_info: payload.ordering_entity_info,
      ship_to: payload.ship_to,
      custom_attributes: payload.custom_attributes,
      customer_wallet: {
        balance: parseInt(customerWallet?.balance),
        product_units_added: parseInt(customerWallet?.balance_product_units),
        service_units_added: parseInt(customerWallet?.balance_service_units)
      },
      selector_url: selectorURL,
      user_selected_bundles: userSelectedBundleLists?.map((usb: UserSelectedBundleListsType) => ({
        sku: usb.bundle_list_sku,
        name: usb.bundle_list_name,
        expiration_date: moment().add(usb.expire_after_days, 'days').format('YYYY-MM-DD HH:mm:ss')
      })),
      warnings: disAllowedBundleProduct
    };
    response.status(200).json({ message: 'Order created successfully!!!', data });
  } catch (error) {
    await DB.rollback();
    next(error);
  }
};

export const assingOrder = async (request: Request, response: Response, next: NextFunction): Promise<any> => {
  await DB.begin();
  try {
    logger.info('Ininitiating the order assign...');
    const account = request.account;
    const payload: AssignOrderRequest = request.body;
    const orderId = payload.order_id.gdt_id || payload.order_id.external_id;
    const userId = payload.user_id.gdt_id || payload.user_id.external_id;
    const assigneeId = payload.assignee?.assignee_id?.gdt_id || payload.assignee?.assignee_id?.external_id;
    const groupId = payload.group_id?.gdt_id || payload.group_id?.external_id;
    const skus: string[] = payload.bundles.map((bundle: BundleRequest) => bundle.sku);
    const order = await Orders.getByIdOrExternalId(orderId);
    if (!order) throw new ClientError({ message: `Order not found with order Id ${orderId}` });
    const dbBundles: BundleWithProducts[] = await Bundles.getBundlesWithProductsBySKUs(skus);
    const purchases: any[] = await UserPurchases.getUserPurchases(order.id, account.account_id);
    const testAssignments: any[] = await TestAssignments.getTestAssignmentByUPIn(
      purchases.map((purchase: any) => purchase.id)
    );
    validateBundles({
      reqBundles: payload.bundles,
      dbBundles,
      orderId: order.id,
      purchases
    });

    const user: User = await Users.getUserBy(account.account_id, 'id', userId);
    if (isEmpty(user)) throw new ClientError({ message: 'User not found' });

    // validate assignee details
    let assignee: any;
    if (assigneeId) {
      assignee = await Users.getUserBy(account.account_id, 'id', assigneeId);
      if (!isEmpty(assignee))
        if (!assignee.active)
          throw new ClientError({ message: `Assignee ID ${assigneeId} is inactive. Cannot proceed.` });
        else if (assignee.account_id !== account.account_id)
          throw new ClientError({
            message: `Assignee ID ${assigneeId} is not a part of the account id ${account.account_id}. Cannot proceed.`
          });
    }
    if (isEmpty(assignee)) {
      if (payload.assignee.minor === 'Y') {
        const { email, phone, first_name, last_name } = payload.assignee;
        assignee = await Users.getUserAssignee(email, phone, first_name, last_name);
        if (isEmpty(assignee)) throw new ClientError({ message: `Assignee details are invalid.` });
        if (assignee.account_id !== account.account_id)
          throw new ClientError({
            message: `Assignee ID ${assigneeId} is not a part of the account id ${account.account_id}. Cannot proceed.`
          });
      } else {
        const {
          assignee_id: { external_id },
          first_name,
          last_name,
          email,
          phone
        } = payload.assignee;
        assignee = await Users.getUserAssignee(email, phone);
        if (isEmpty(assignee)) throw new ClientError({ message: `Assignee details are invalid.` });
        if (assignee.account_id !== account.account_id)
          throw new ClientError({
            message: `Assignee ID ${assigneeId} is not a part of the account id ${account.account_id}. Cannot proceed.`
          });
        if (email === assignee.email && phone !== assignee.phone_number)
          await Users.updateUser({ phone_number: phone }, { email });
        else if (email !== assignee.email) {
          assignee = await Users.createUser(account.account_id, {
            email: email,
            external_id: external_id || null,
            name: first_name,
            last_name: last_name,
            phone_number: phone,
            user_role: 1
          });
        }
      }
    }

    // validate group details
    const group = groupId
      ? await GroupDetails.getByIdOrExternalId(groupId)
      : payload.group_name
        ? await GroupDetails.getBy('group_name', payload.group_name)
        : null;
    if (groupId && payload.group_name && isEmpty(group))
      throw new ClientError({
        message: `Assignment requested that assignee be added to Group ID ${groupId || payload.group_name} but this group is invalid.`
      });
    else if (!isEmpty(group)) {
      if (group.account_id !== account.account_id)
        throw new ClientError({
          message: `Assignee ID ${assigneeId} is not a part of the account id ${account.account_id}. Cannot proceed.`
        });

      // Make group membership
      if (!isEmpty(group)) {
        const groupMembership = await GroupMemberships.getBys({ user_id: assignee.id, group_id: group.id });
        if (isEmpty(groupMembership)) await GroupMemberships.create({ user_id: assignee.id, group_id: group.id });
      }
    }

    await Promise.all(
      dbBundles.map(async (bundle: any) => {
        const testAssignment = testAssignments.find((ta: any) => ta.bundle_id === bundle.id);
        const purchase = purchases.find((purchase: any) => purchase.bundle_id === bundle.id);
        const reqBundle = payload.bundles.find((reqBundle: BundleRequest) => reqBundle.sku === bundle.bundle_sku);
        if (purchase.purchased_tests > 0) {
          // have slot
          if (isEmpty(testAssignment)) {
            const { insertId } = await TestAssignments.create({
              user_purchase_id: purchase?.id,
              assigned_by: user.id,
              assigned_to: assignee?.id,
              assigned_datetime: moment().format(DATE.LONG),
              name: payload.assignee.first_name,
              last_name: payload.assignee.last_name,
              address: payload.assignee.address.street_1,
              address2: payload.assignee.address.street_2,
              city: payload.assignee.address.city,
              postal: payload.assignee.address.postal_code,
              state: payload.assignee.address.region,
              country: payload.assignee.address.country,
              bundle_id: bundle.id,
              recipient_type: checkYesOrNoValue(payload.assignee.minor) ? 'minor' : 'adult',
              ...(reqBundle?.flavor_id &&
                [FLAVOR_CODES.TEST_ONLY, FLAVOR_CODES.TEST_AND_EDUCATION].includes(reqBundle?.flavor_id) && {
                  total_assigned_test: 1
                }),
              ...(reqBundle?.flavor_id &&
                [FLAVOR_CODES.EDUCATION_ONLY, FLAVOR_CODES.TEST_AND_EDUCATION].includes(reqBundle?.flavor_id) && {
                  total_assigned_observation: 1
                })
            });
            const testAssigmentObsevationLinkerData = {
              test_assignment_id: insertId,
              experiences_by_account_id: account.account_id,
              bundle_id: bundle.id,
              status: 0,
              order_by: 1
            };
            await TestAssigmentObsevationLinker.create(testAssigmentObsevationLinkerData);
          } else if (purchase.purchased_tests > testAssignment.total_assigned_test) {
            await TestAssignments.update(
              {
                ...(reqBundle?.flavor_id &&
                  [FLAVOR_CODES.TEST_ONLY, FLAVOR_CODES.TEST_AND_EDUCATION].includes(reqBundle?.flavor_id) && {
                    total_assigned_test: testAssignment.total_assigned_test + 1
                  }),
                ...(reqBundle?.flavor_id &&
                  [FLAVOR_CODES.EDUCATION_ONLY, FLAVOR_CODES.TEST_AND_EDUCATION].includes(reqBundle?.flavor_id) && {
                    total_assigned_observation: testAssignment.total_assigned_observation + 1
                  })
              },
              { id: testAssignment.id }
            );
          } else
            throw new ClientError({
              message: `There is no slot available for bundle SKU (${reqBundle?.sku}) to assign`
            });
        }
      })
    );

    await DB.commit();
    response.status(200).json({
      message: 'Order assign successfully!!!',
      data: {
        order_id: { gdt_id: order.id, external_id: order.external_id },
        assignee_id: { gdt_id: assignee.id, external_id: assignee.external_id },
        create_date: moment().format(DATE.SHORT)
      }
    });
  } catch (error) {
    await DB.rollback();
    next(error);
  }
};

export const updateOrder = async (request: Request, response: Response, next: NextFunction) => {
  await DB.begin();
  try {
    const account = request.account;
    const payload: UpdateOrderRequest = request.body;
    const orderId = payload.order_id.gdt_id || payload.order_id.external_id;
    const order = await Orders.getByIdOrExternalId(orderId);
    if (!order) throw new ClientError({ message: `Order not found with order Id ${orderId}` });
    const globalSettings: GlobalSetting = await GlobalSettings.getGlobalSettings();
    const newStatus = await Status.getStatusBy({
      language_id: 1,
      support_entity_id: order.support_entity_id,
      'STY.id': STAGE_TYPE.ORDER,
      'SM.status_key': payload.order_status
    });
    if (isEmpty(newStatus))
      throw new ClientError({
        message: `Invalid status '${payload.order_status}' provided.`
      });

    const orderStatus = await Status.getById(order.internal_order_status_mapping_id);
    if (orderStatus.internal_status === STATUSES.ORDER.ARRIVED)
      throw new ClientError({ message: `Order is already delivered. Cannot update the order.` });
    if (orderStatus.internal_status === STATUSES.ORDER.CANCELED)
      throw new ClientError({ message: `Order has already been cancelled. Cannot update the order.` });

    const purchases: UserPurchase[] = await UserPurchases.getUserPurchases(order.id, account.account_id);
    const bundleIds = purchases.map((purchase: UserPurchase) => purchase.bundle_id);
    const shipmentProductsMapping: ShipmentProductsMappings[] =
      await ShipmentProductsMapping.getShipmentProductsMapping(bundleIds, order.id);
    let isOrderShipped = false;
    let messagingTypeId: number | undefined = 0;
    if (!isEmpty(shipmentProductsMapping)) {
      isOrderShipped = shipmentProductsMapping.some(
        (mapping: ShipmentProductsMappings) => mapping.status !== STATUSES.SHIPMENT.PROCESSING
      );
      for (const mapping of shipmentProductsMapping) {
        messagingTypeId = getMessageTypeIdByShipmentStatus(mapping.status);
        if (messagingTypeId) break;
      }
    }

    if (orderStatus.internal_status === STATUSES.ORDER.CANCELED) {
      await Orders.updateOrderStatus(order.id, orderStatus.internal_status_id, orderStatus.external_status_id);
      await OrderEventHistory.create({
        electronic_order_id: order.id,
        external_status_mapping_id: orderStatus.external_status_id,
        internal_status_mapping_id: orderStatus.internal_status_id,
        status: orderStatus.internal_status
      });
      await OutboundWebhookQueue.update(
        { status_name: orderStatus.internal_status, updated_at: new Date() },
        { relation_id: order.id }
      );
      const assignments: Assignment[] = await TestAssignments.getAllAssignmentsByOrderId(order.id);
      const uniqueAssignments = uniqBy(assignments, 'assignee_id');
      for (const assignment of uniqueAssignments) {
        const replacements = {
          customer_name: `${assignment.assignee_name} ${assignment.assignee_last_name}`,
          assignee_first_name: assignment.assignee_name,
          text_choice_for_product_plural: WORD_MAP[globalSettings.default_word] ?? '',
          app_name: globalSettings.app_name ?? ''
        };
        await enqueueEmail({
          messageId: account.messaging_id,
          templateId: messagingTypeId,
          email: assignment.assignee_email,
          name: `${assignment.assignee_name} ${assignment.assignee_last_name}`,
          relationId: order.id,
          replacements
        });
      }

      for (const assignment of uniqueAssignments) {
        const replacements = {
          name: `${assignment.assignee_name} ${assignment.assignee_last_name}`,
          order_cancel_date: new Date(),
          assignee_name: assignment.assignee_name
        };
        await enqueueEmail({
          messageId: account.messaging_id,
          templateId: 61,
          email: assignment.assignee_email,
          name: `${assignment.assignee_name} ${assignment.assignee_last_name}`,
          relationId: order.id,
          replacements
        });
      }
    }

    if (!isEmpty(payload.custom_attributes)) {
      logger.info('Found custom attributes. Creating user purchase attributes...');
      await UserPurchasesAttributes.delete({ electronic_order_id: order.id });
      const attributes = Object.entries(payload.custom_attributes).map(([key, value]) => ({
        electronic_order_id: order.id,
        attribute_key: key,
        attribute_value: value
      }));
      await UserPurchasesAttributes.createUserPurchaseAttributes(attributes);
    }
    await Orders.update({ updated_at: new Date() }, { id: order.id });

    if (orderStatus.internal_status === STATUSES.ORDER.CANCELED && isOrderShipped) {
      response.status(200).json({ message: 'Order is canceled but shipment was already sent. Cannot refund order.' });
    }

    await DB.commit();
    response.status(200).json({ message: 'Order updated successfully!!!' });
  } catch (error) {
    await DB.rollback();
    next(error);
  }
};

export const listOrders = async (request: Request, response: Response, next: NextFunction) => {
  try {
    const account = request.account;
    const filters = request.query;
    const orders: ListOrder[] = await Orders.getOrders(account.account_id, filters);
    const uniqueBundleSKUs = uniq(orders.map((order: ListOrder) => order.bundle_sku));
    if (isEmpty(uniqueBundleSKUs)) response.status(200).json({ message: 'Orders fetched successfully!!!', data: [] });
    const dbBundles: BundleWithProducts[] = await Bundles.getBundlesWithProductsBySKUs(uniqueBundleSKUs);
    // Create lookup map for bundles for O(1) access
    const bundleMap = dbBundles.reduce((map: { [key: string]: BundleWithProducts }, bundle: BundleWithProducts) => {
      map[bundle.bundle_sku] = bundle;
      return map;
    }, {});

    const data = orders.reduce((acc: { [key: string]: any }, item: ListOrder) => {
      const key = item.electronic_order_id.toString();

      // Initialize order if not exists
      if (!acc[key]) {
        acc[key] = {
          order_id: {
            internal_id: item.electronic_order_id,
            external_id: item.external_order_id
          },
          order_status: item.status_key,
          order_type:
            item.is_bulk_shipping === 1 ? ORDER_TYPES_CODE.BULK_SHIPMENT : ORDER_TYPES_CODE.INDIVIDUAL_SHIPMENT,
          order_type_description:
            item.is_bulk_shipping === 1 ? ORDER_TYPE_DES.BULK_SHIPMENT : ORDER_TYPE_DES.INDIVIDUAL_SHIPMENT,
          order_date: new Date(item.order_created_at).toISOString().split('T')[0],
          order_update_date: item.order_updated_at ? new Date(item.order_updated_at).toISOString().split('T')[0] : null,
          bundles: [],
          recipientDetails: {
            first_name: item.first_name,
            last_name: item.last_name,
            phone: item.phone,
            email: item.email,
            address: {
              street1: item.street1,
              street2: item.street2,
              postal_code: item.postal_code,
              city: item.city_name,
              state: item.state_name,
              country: item.country_name
            }
          }
        };
      }

      // Add bundle if not exists
      const existingBundle = acc[key].bundles.find((bundle: any) => bundle.sku === item.bundle_sku);
      if (!existingBundle) {
        const filteredBundle = bundleMap[item.bundle_sku];
        acc[key].bundles.push({
          sku: item.bundle_sku,
          quantity: calculateQuantity(item),
          flavor_id: item.variations,
          flavor_description: getFlavorDescription(item.variations),
          diagnosisCode: item.diagnosis_code,
          billingCode: item.billing_code,
          products: filteredBundle?.products?.map((product: any) => product.product_name) || []
        });
      }

      return acc;
    }, {});

    response.status(200).json({ message: 'Orders fetched successfully!!!', data: Object.values(data) });
  } catch (error) {
    next(error);
  }
};

export const getOrderById = async (request: Request, response: Response, next: NextFunction) => {
  try {
    const account = request.account;
    const orderId: string = request.params.order_id;
    const order = await Orders.getByIdOrExternalId(orderId);
    if (isEmpty(order)) throw new ClientError({ message: 'Order not found' });
    const orderWithBundleAndShipmentRecipient: OrderWithBundleAndShipmentRecipient[] = await Orders.getOrderById(
      account.account_id,
      orderId
    );
    if (isEmpty(orderWithBundleAndShipmentRecipient))
      throw new ClientError({ message: `Order not found with order Id ${orderId}` });
    const uniqueBundleSKUs: string[] = uniq(
      orderWithBundleAndShipmentRecipient.map((order: OrderWithBundleAndShipmentRecipient) => order.bundle_sku)
    );
    const uniqueBundleIds: number[] = uniq(
      orderWithBundleAndShipmentRecipient.map((order: OrderWithBundleAndShipmentRecipient) => order.mapped_bundle_id)
    );
    if (isEmpty(uniqueBundleSKUs)) response.status(200).json({ message: 'Order fetched successfully!!!', data: {} });
    const dbBundles: BundleWithProducts[] = await Bundles.getBundlesWithProductsBySKUs(uniqueBundleSKUs);
    const userPurchases = await UserPurchases.getUserPurchasesByOrderId(order.id);
    const userPurchasesAttributes: UserPurchase[] = await UserPurchasesAttributes.getUserPurchasesAttributesByOrderId(
      order.id
    );
    const custom_attributes = userPurchasesAttributes.map((attribute: UserPurchase) => ({
      [attribute.attribute_key]: attribute.attribute_value
    }));
    const shipmentProductsMapping: ShipmentProductsMappings[] =
      await ShipmentProductsMapping.getShipmentProductsMapping(uniqueBundleIds, order.id);
    let mergedShipments: ShipmentProductsMappings[] = [];
    if (!isEmpty(shipmentProductsMapping)) {
      const shipmentIds = shipmentProductsMapping.map((mapping: ShipmentProductsMappings) => mapping.shipment_id);
      const shipmentEventHistories: ShipmentEventHistoryType[] =
        await ShipmentEventHistory.getShipmentEventHistory(shipmentIds);
      if (!isEmpty(shipmentEventHistories)) {
        const shipmentHistoryMap = shipmentEventHistories.reduce(
          (acc: { [key: number]: any }, history: ShipmentEventHistoryType) => {
            if (!acc[history?.shipment_id]) acc[history?.shipment_id] = [];
            acc[history.shipment_id].push({
              created_at: history.created_at,
              external_status_mapping_id: history.external_status_mapping_id,
              status_key: history.status_key
            });
            return acc;
          },
          {}
        );
        mergedShipments = shipmentProductsMapping.map((shipment: ShipmentProductsMappings) => ({
          ...shipment,
          event_histories: shipmentHistoryMap[shipment.shipment_id] || []
        }));
      }
    }

    const firstItem = orderWithBundleAndShipmentRecipient[0];
    const data = {
      order_id: {
        internal_id: firstItem.electronic_order_id,
        external_id: firstItem.external_order_id
      },
      order_status: firstItem.status_key,
      order_date: moment(firstItem.order_created_at).format(DATE.DASHED_SHORT),
      order_update_date: firstItem.order_updated_at
        ? moment(firstItem.order_updated_at).format(DATE.DASHED_SHORT)
        : null,
      account_id: account.account_id,
      registrant_info: userPurchases,
      bundles: orderWithBundleAndShipmentRecipient.reduce((acc: any[], item: OrderWithBundleAndShipmentRecipient) => {
        const existingBundle = acc.find(bundle => bundle.sku === item.bundle_sku);
        if (!existingBundle) {
          const filteredBundle: BundleWithProducts | undefined = dbBundles.find(
            bundle => bundle.bundle_sku === item.bundle_sku
          );
          const quantity =
            item.variations === 1
              ? item.purchased_tests
              : item.variations === 2
                ? item.purchased_tests + item.purchased_observations
                : item.variations === 3
                  ? item.purchased_observations
                  : 0;

          acc.push({
            sku: item.bundle_sku,
            quantity,
            flavor_id: item.variations,
            diagnosisCode: item.diagnosis_code,
            billingCode: item.billing_code,
            products: filteredBundle?.products?.map((product: Product) => product.name) || []
          });
        }
        return acc;
      }, []),
      recipientDetails: {
        first_name: firstItem.first_name,
        last_name: firstItem.last_name,
        phone: firstItem.phone,
        email: firstItem.email,
        address: {
          street1: firstItem.street1,
          street2: firstItem.street2,
          postal_code: firstItem.postal_code,
          city: firstItem.city_name,
          state: firstItem.state_name,
          country: firstItem.country_name
        }
      },
      order_information: {
        full_name: order.ordering_name,
        ordered_by_entity_name: order.ordering_entity_name,
        ordered_by_id: order.order_license_id,
        ordered_by_email: order.ordering_email,
        ordered_by_phone: order.ordering_phone
      },
      custom_attributes,
      fulfillment: dbBundles.map(bundle => ({
        bundle_id: bundle.id,
        bundle_name: bundle.bundle_name,
        products: bundle.products.map(product => {
          const shipment = mergedShipments.find(s => s.product_id === product.product_id && s.bundle_id === bundle.id);

          return {
            product_id: product.product_id,
            product_name: product.name,
            kit_type: null,
            kit_sku: null,
            kit_status: null,
            status_history: null,
            shipment_details: shipment
              ? {
                  shipping_type: shipment.shipping_type
                    ? shipment.shipping_type === 1
                      ? SHIPMENT_TYPE_NAME.CUSTOMER
                      : SHIPMENT_TYPE_NAME.RETURN
                    : null,
                  tracking_id: shipment.shipment_tracking_id,
                  carrier_code: shipment.carrier_code,
                  shipment_date: moment(shipment.shipment_date).format(DATE.DASHED_SHORT),
                  shipment_history: shipment.event_histories || []
                }
              : null,
            specimen_data: null,
            report_data: null
          };
        })
      }))
    };

    response.status(200).json({ message: 'Order fetched successfully!!!', data });
  } catch (error) {
    next(error);
  }
};
