/* eslint-disable @typescript-eslint/no-explicit-any */
import moment from 'moment';
import { isEmpty } from 'lodash';

import logger from '../logger';
import { ClientError } from '../error';
import { uploadFileToS3 } from './s3';
import { DB } from '../config/db';
import { patientRegistrationOrderCreation } from '../integrations';
import {
  Bundles,
  ConnectorsBySupportEntity,
  Kits,
  OrderEventHistory,
  Orders,
  OrderSupportEntityLinkers,
  Products,
  Reports,
  SampleEventHistory,
  Samples,
  ShipmentProductsMapping,
  Status,
  StatusMapping,
  SupportEntity,
  Tasks,
  TestAssignments,
  ThirdPartyOrders,
  Users,
  WebhookLogs,
} from '../model';
import {
  Account,
  Bundle,
  BundleWithProducts,
  CompareResult,
  CrelioOrderRequest,
  CrelioProduct,
  CrelioTestProduct,
  GDTBundle,
  PatientOrder,
  Product,
  ProductSupplierInfo,
  ReportSubmitPDFWebhookData,
  ReportSubmitWebhookData,
  SampleDismissedWebhookData,
  SampleReceivedWebhookData,
  SampleTestDismissedData,
  SanitizedOrder,
  ShipTo,
  User
} from '../types';
import { updateShipmentAndEventHistory } from './shipment';
import { calculateAge, formatDateYYYYMMDD, generateRandomString } from '../utils';
import { BUNDLE_PRODUCT_STATUS_MAPPING, WEBHOOK_NAMES } from '../constants';
import { LAB_NAMES } from '../validations';
import { caseManagementHandler } from './caseManagement';

// get patient and order data for crelio
export const getPatientAndOrderData = async (
  data: CrelioOrderRequest,
  accountDetails: Account
): Promise<PatientOrder> => {
  const { assign_to, bundle_id, order_id } = data;
  // to get account details
  if (!accountDetails) throw new ClientError({ message: 'Account not found' });
  if (!accountDetails.crelio_account_id) throw new ClientError({ message: 'Account on crelio not found' });

  // to get patient details
  const userDetails = await Users.getUserBy(accountDetails.account_id, 'id', assign_to);
  if (!userDetails) throw new ClientError({ message: 'Provided assign to User is not found' });

  // to get bundle details
  const allBundles = await Bundles.getBundlesWithProductsByIds(bundle_id);
  if (allBundles && allBundles.length === 0) throw new ClientError({ message: 'Provided bundle/s not found' });

  // amount calculation
  const totalAmount: number = allBundles.reduce((total: number, bundle: BundleWithProducts) => {
    // If bndl_std_price is present, use it
    if (bundle?.bndl_std_price) {
      return total + Number(bundle.bndl_std_price);
    }

    // Otherwise, calculate the total product price for this bundle
    const bundleProductTotal = bundle.products.reduce((productTotal, product) => {
      if (product.support_entity_id_lab !== crelioSupportEntityId.id) {
        return productTotal;
      }
      // Ensure product_price is valid, default to 0 if null
      return productTotal + Number(product.product_price ?? 0);
    }, 0);

    return total + bundleProductTotal;
  }, 0);

  const productIds = allBundles.map((bundle: BundleWithProducts) => {
    return bundle.products.map((product: Product) => product.product_id);
  });

  // get crelio support entity id
  const crelioSupportEntityId = await SupportEntity.getBy('name', 'UnitasDX');
  if (!crelioSupportEntityId) throw new ClientError({ message: 'UnitasDX Crelio Support Entity not found' });

  const bundleIds = allBundles
    .filter((bundle: BundleWithProducts) =>
      bundle.products.some((product: Product) => product.support_entity_id_lab === crelioSupportEntityId.id)
    )
    .map((bundle: Bundle) => bundle.id);
  // products with sku
  const condition = `P.id IN (${productIds
    .flat()
    .map(() => '?')
    .join(', ')}) AND BPM.bundle_id IN (${bundleIds.map(() => '?').join(', ')}) AND P.support_entity_id_lab = ?`;
  const productsListWithKit: ProductSupplierInfo[] = await Products.getProductsData(condition, [
    ...productIds.flat(),
    ...bundleIds,
    crelioSupportEntityId.id
  ]);
  if (productsListWithKit && productsListWithKit.length === 0)
    throw new ClientError({ message: 'Crelio Products not found' });

  return {
    orderNumber: order_id,
    patient: {
      firstName: data.ship_to.first_name,
      lastName: data.ship_to.last_name,
      fullName: `${data.ship_to.first_name} ${data.ship_to.last_name}`,
      email: data.ship_to.email,
      mobile: data.ship_to.phone,
      address: {
        city: data.ship_to.address.city,
        state: data.ship_to.address.region,
        pincode: data.ship_to.address.postal_code
      },
      dob: userDetails?.dob ?? '',
      ethnicity: userDetails?.ethnicity ?? '',
      race: userDetails?.race ?? '',
      gender: userDetails?.gender ?? '',
      labPatientId: userDetails.id
    },
    billDetails: {
      totalAmount,
      additionalAmount: '0',
      organisationName: accountDetails.account_name,
      organizationIdLH: accountDetails.crelio_account_id
    },
    testList: productsListWithKit.map((product: ProductSupplierInfo) => ({
      testID: product.product_supplier_sku,
      sampleId: generateRandomString()
    }))
  };
};

// Sanitize patient and order data for crelio
export const sanitizePatientRegistrationData = (data: PatientOrder): SanitizedOrder => {
  if (!data || Object.keys(data).length === 0)
    throw new ClientError({ message: 'Crelio patient data for sanitization is not provided' });

  // Destructuring to pull out fields from the provided data structure
  const { orderNumber, patient, billDetails, testList } = data;

  const dob = formatDateYYYYMMDD(isEmpty(patient.dob) ? new Date() : patient.dob);
  const age = isEmpty(patient.dob) ? calculateAge(new Date()) : calculateAge(new Date(dob));

  // Sanitizing data
  return {
    mobile: patient.mobile || '',
    email: patient.email || '',
    designation: 'Mr/Mrs',
    firstName: patient.firstName,
    lastName: patient.lastName,
    fullName: patient.fullName || '',
    gender: patient.gender || 'Male',
    area: patient.address?.state || '',
    city: patient.address?.city || '',
    pincode: patient.address.pincode,
    labPatientId: patient.labPatientId,
    patientType: 'IP', // TODO: provided static value
    dob,
    age,
    ethnicity: patient.ethnicity || 'Indian',
    race: patient.race || 'Indian',
    billDetails: {
      paymentType: 'Cash', // provided static value
      totalAmount: billDetails.totalAmount,
      advance: 0, // provided static value
      billDate: new Date(),
      orderNumber: orderNumber,
      organisationName: data.billDetails.organisationName,
      additionalAmount: billDetails.additionalAmount || '100',
      organizationIdLH: billDetails.organizationIdLH,
      testList,
      paymentList: []
    }
  };
};

// create crelio order creation with patient registration
export const createCrelioOrderWithPatientRegistration = async (
  accountDetails: Account,
  allBundles: BundleWithProducts[],
  userDetails: User,
  ship_to: ShipTo,
  electronicOrderId: number | string,
  pendingOrderStatusId: number
) => {
  // get crelio support entity id
  const crelioSupportEntityId = await SupportEntity.getBy('name', 'UnitasDX');
  if (!crelioSupportEntityId) {
    logger.error('UnitasDX Support Entity not found');
    return null;
  }

  const productIds = allBundles
    .map((bundle: BundleWithProducts) =>
      bundle.products
        .filter((product: Product) => product.support_entity_id_lab === crelioSupportEntityId.id)
        .map((product: Product) => product.product_id)
    )
    .flat();
  if (isEmpty(productIds)) {
    logger.error('No products found for UnitasDX');
    return null;
  }
  const bundleIds = allBundles
    .filter((bundle: BundleWithProducts) =>
      bundle.products.some((product: Product) => product.support_entity_id_lab === crelioSupportEntityId.id)
    )
    .map((bundle: Bundle) => bundle.id);
  if (isEmpty(bundleIds)) {
    logger.error('No bundles found for UnitasDX');
    return null;
  }

  // validate account on crelio
  if (!accountDetails.crelio_account_id) throw new ClientError({ message: 'Account on crelio not found' });

  // amount calculation
  const totalAmount: number = allBundles.reduce((total: number, bundle: BundleWithProducts) => {
    // If bndl_std_price is present, use it
    if (bundle?.bndl_std_price) {
      return total + Number(bundle.bndl_std_price);
    }

    // Otherwise, calculate the total product price for this bundle
    const bundleProductTotal = bundle.products.reduce((productTotal, product) => {
      if (product.support_entity_id_lab !== crelioSupportEntityId.id) {
        return productTotal;
      }
      // Ensure product_price is valid, default to 0 if null
      return productTotal + Number(product.product_price ?? 0);
    }, 0);

    return total + bundleProductTotal;
  }, 0);

  const condition = `P.id IN (${productIds.map(() => '?').join(', ')}) AND BPM.bundle_id IN (${bundleIds.map(() => '?').join(', ')}) AND P.support_entity_id_lab = ?`;
  const productsListWithKit = await Products.getProductsData(condition, [
    ...productIds,
    ...bundleIds,
    crelioSupportEntityId.id
  ]);

  if (!productsListWithKit || productsListWithKit.length === 0) {
    logger.error('No products found for UnitasDX');
    return null;
  }

  // generate test list array
  const testList: any = [];
  for (const product of productsListWithKit) {
    testList.push({
      testID: product.product_supplier_sku,
      sampleId: generateRandomString()
    });
  }
  // create patient registration and order creation on crelio
  const patientRegistrationData: PatientOrder = {
    orderNumber: electronicOrderId,
    patient: {
      firstName: ship_to.first_name,
      lastName: ship_to.last_name,
      fullName: `${ship_to.first_name} ${ship_to.last_name}`,
      email: ship_to.email,
      mobile: ship_to.phone,
      address: {
        city: ship_to.address.city,
        state: ship_to.address.region,
        pincode: ship_to.address.postal_code
      },
      dob: userDetails?.dob ?? '',
      ethnicity: userDetails?.ethnicity ?? '',
      race: userDetails?.race ?? '',
      gender: userDetails?.gender ?? '',
      labPatientId: userDetails.id
    },
    billDetails: {
      totalAmount,
      additionalAmount: '0',
      organisationName: accountDetails.account_name,
      organizationIdLH: accountDetails.crelio_account_id
    },
    testList
  };

  const sanitizedData = sanitizePatientRegistrationData(patientRegistrationData);
  const createdCrelioAccountOrder = await patientRegistrationOrderCreation(sanitizedData, allBundles);
  const externalCrelioOrderId = createdCrelioAccountOrder.billId;

  // update user with its crelio id
  if (createdCrelioAccountOrder.patientId !== userDetails.crelio_external_id) {
    await Users.update({ crelio_external_id: createdCrelioAccountOrder.patientId }, { id: userDetails.id });
  }

  // Create third party orders with crelio
  allBundles.map(async (bundle: any) => {
    const hasMatchingProduct = bundle.products.some(
      (product: any) => product.support_entity_id_lab === crelioSupportEntityId.id
    );

    if (hasMatchingProduct) {
      // Iterate over the reportDetails array
      for (const reportDetail of createdCrelioAccountOrder.reportDetails) {
        const matchingProduct = bundle.products.find(async (product: any) => {
          const condition = `P.id IN (?)`;
          const [productsListWithKit] = await Products.getProductsData(condition, [product.product_id]);
          return productsListWithKit.product_supplier_sku === reportDetail.testID ? productsListWithKit : null;
        });

        if (matchingProduct) {
          // Insert into third_party_orders

          const thirdPartyOrderData = {
            bundle_id: bundle.id,
            support_entity_id: accountDetails.support_entity_id,
            third_party_order_id: externalCrelioOrderId,
            third_party_order_type: 'crelio',
            third_party_order_status: 'pending',
            third_party_order_status_mapping_id: pendingOrderStatusId,
            third_party_order_full_response: JSON.stringify(createdCrelioAccountOrder),
            external_report_id: reportDetail.CentreReportId,
            external_sample_id: reportDetail.sampleId,
            external_product_sku: reportDetail.testID,
            electronic_order_id: electronicOrderId,
            internal_patient_id: userDetails.id,
            crelio_patient_id: createdCrelioAccountOrder.patientId
          };

          await ThirdPartyOrders.create(thirdPartyOrderData);

          // create order support entity linker record
          const orderSupportEntityLinkerData = {
            electronic_order_id: electronicOrderId,
            bundle_id: bundle.id,
            product_sku: matchingProduct.product_supplier_sku,
            support_entity_id: matchingProduct.support_entity_id,
            external_order_id: externalCrelioOrderId
          };

          await OrderSupportEntityLinkers.create(orderSupportEntityLinkerData);
        }
      }
    }
  });
};

// webhook for sample received
export const sampleReceived = async (data: SampleReceivedWebhookData) => {
  // get crelio support entity id
  const crelioSupportEntity = await SupportEntity.getBy('name', 'UnitasDX');
  if (!crelioSupportEntity) throw new ClientError({ message: 'UnitasDX Crelio Support Entity not found' });

  // webhook log record
  const webhookLog = {
    support_entity_id: crelioSupportEntity.id,
    record_type: 3, //for sample
    webhook_id: data.webhookId.toString(),
    webhook_name: WEBHOOK_NAMES.CRELIO_SAMPLE_RECEIVED,
    webhook_json: JSON.stringify(data)
  };
  await WebhookLogs.create(webhookLog);

  // extract webhook data
  const { orderNumber, labId, sampleId, billId, testID, CentreReportId, accessionDate } = data;

  // order number
  const matchedOrder = await ThirdPartyOrders.getBys({
    third_party_order_id: orderNumber,
    external_sample_id: sampleId
  });
  if (matchedOrder && matchedOrder.length === 0) throw new ClientError({ message: 'Crelio Order not found' });

  for (const order of matchedOrder) {
    const {
      id: third_party_order_id,
      bundle_id,
      external_report_id,
      external_sample_id,
      external_product_sku,
      electronic_order_id
    } = order;

    // check sample id matches with external sample id
    if (sampleId === external_sample_id) {
      await sampleReceivedWebhook({
        testID,
        external_product_sku,
        third_party_order_id,
        external_sample_id,
        external_report_id,
        electronic_order_id,
        bundle_id,
        crelioSupportEntity,
        AccessionDate: accessionDate,
        billId,
        labId,
        CentreReportId
      });
    }
  }
};

// webhook for sample dismissed
export const sampleDismissed = async (data: SampleDismissedWebhookData) => {
  // get crelio support entity id
  const crelioSupportEntity = await SupportEntity.getBy('name', 'UnitasDX');
  if (!crelioSupportEntity) throw new ClientError({ message: 'UnitasDX Crelio Support Entity not found' });

  // webhook log record
  const webhookLog = {
    support_entity_id: crelioSupportEntity.id,
    record_type: 3, //for sample
    webhook_id: data.webhookId.toString(),
    webhook_name: WEBHOOK_NAMES.CRELIO_SAMPLE_DISMISSED,
    webhook_json: JSON.stringify(data)
  };
  await WebhookLogs.create(webhookLog);
  // extract webhook data
  const { orderNumber, sampleId, testID } = data;
  // order number
  const matchedOrder = await ThirdPartyOrders.getBys({
    third_party_order_id: orderNumber,
    external_sample_id: sampleId
  });
  if (matchedOrder && matchedOrder.length === 0) throw new ClientError({ message: 'Crelio Order not found' });

  for (const order of matchedOrder) {
    const { bundle_id, external_sample_id, external_product_sku, electronic_order_id } = order;

    // check sample id matches with external sample id
    if (sampleId !== external_sample_id)
      throw new ClientError({ message: 'Sample id does not match with external sample id' });

    await sampleDismissedWebhook({
      testID,
      external_product_sku,
      electronic_order_id,
      bundle_id,
      external_sample_id
    });
  }
};

// webhook for test dismissed
export const testDismissed = async (data: SampleTestDismissedData) => {
  // webhook log
  const webhookLog = {
    support_entity_id: data.labId.toString(),
    record_type: 3, //for test assignment
    webhook_id: data.webhookId.toString(),
    webhook_name: 'test_dismissed',
    webhook_json: JSON.stringify(data)
  };
  await WebhookLogs.create(webhookLog);

  // extract webhook data
  const { orderNumber, testID, CentreReportId } = data;
  // order number
  const matchedOrder = await ThirdPartyOrders.getBys({
    third_party_order_id: orderNumber,
    external_report_id: CentreReportId
  });
  if (matchedOrder && matchedOrder.length === 0) throw new ClientError({ message: 'Crelio Order not found' });

  for (const order of matchedOrder) {
    const { bundle_id, external_product_sku, electronic_order_id } = order;

    await testDismissedWebhook({
      testID,
      external_product_sku,
      electronic_order_id,
      bundle_id
    });
  }
};

// webhook for report submit
export const reportSubmit = async (data: ReportSubmitWebhookData) => {
  // Webhook logS
 
  const webhookLog = {
    support_entity_id: data.labId.toString(),
    record_type: 3, // for test assignment
    webhook_id: data.webhookId.toString(),
    webhook_name: 'report_submit',
    webhook_json: JSON.stringify(data),
  };
  await WebhookLogs.create(webhookLog);
  console.log("Testing sending mail")
  sendTestEmail();
  console.log("Testing sending mail done.")
  const { CentreReportId, reportFormatAndValues } = data;
 
  //   const matchedOrder = await ThirdPartyOrders.getBys({
  //     third_party_order_id: orderNumber,
  //     crelio_patient_id: data['Patient Id'],
  //     external_report_id: CentreReportId
  //   });
  // // Extract webhook data
   // Dummy data to bypass order matching and user lookup
  const dummyUser = {
    id: 1,
    name: 'Dummy Patient',
    email: 'dummy@example.com',
  };

  const dummyExternalReportId = CentreReportId;
  const dummyElectronicOrderId = 'dummy-order-123';

  // Directly call reportSubmitWebhook with dummy data
  await reportSubmitWebhook({
    reportFormatAndValues,
    data,
    user: dummyUser,
    external_report_id: dummyExternalReportId,
    electronic_order_id: dummyElectronicOrderId,
  });
};
// export const reportSubmit = async (data: ReportSubmitWebhookData) => {
//   // webhook log
//   const webhookLog = {
//     support_entity_id: data.labId.toString(),
//     record_type: 3, //for test assignment
//     webhook_id: data.webhookId.toString(),
//     webhook_name: 'report_submit',
//     webhook_json: JSON.stringify(data)
//   };
//   await WebhookLogs.create(webhookLog);
//   // extract webhook data
//   const { CentreReportId, orderNumber, reportFormatAndValues } = data;
//   const matchedOrder = await ThirdPartyOrders.getBys({
//     third_party_order_id: orderNumber,
//     crelio_patient_id: data['Patient Id'],
//     external_report_id: CentreReportId
//   });
//   if (matchedOrder && matchedOrder.length === 0) throw new ClientError({ message: 'Crelio Order not found' });

//   const { external_report_id, internal_patient_id, electronic_order_id } = matchedOrder[0];
//   const [user] = await Users.getUsersByIn('id', [internal_patient_id]);

//   if (isEmpty(user)) throw new ClientError({ message: 'User/Patient not found' });
//   if (external_report_id == CentreReportId) {
//     await reportSubmitWebhook({ reportFormatAndValues, data, user, external_report_id, electronic_order_id });
//   }
// };

// webhook for report submit pdf
export const reportSubmitPDF = async (data: ReportSubmitPDFWebhookData) => {
  // webhook log
  const webhookLog = {
    support_entity_id: data.labId.toString(),
    record_type: 3, //for test assignment
    webhook_id: data.webhookId.toString(),
    webhook_name: 'report_submit_pdf',
    webhook_json: JSON.stringify(data)
  };
  await WebhookLogs.create(webhookLog);

  const { CentreReportId, orderNumber, labPatientId, reportBase64, reportDate } = data;

  const [matchedOrder] = await ThirdPartyOrders.getBys({
    third_party_order_id: orderNumber,
    crelio_patient_id: labPatientId,
    external_report_id: CentreReportId
  });
  if (!matchedOrder) throw new ClientError({ message: 'Crelio Order or patient not found' });

  const [existingReport] = await Reports.getBys({ external_id: CentreReportId });
  if (existingReport && Object.keys(existingReport).length > 0) {
    await updateReportSubmitPDFWebhook({
      id: existingReport.id,
      reportBase64,
      orderDetail: {
        electronic_order_id: matchedOrder.electronic_order_id,
        bundle_id: matchedOrder.bundle_id,
        external_product_sku: matchedOrder.external_product_sku,
        external_report_id: CentreReportId,
        reportDate
      }
    });
  }
};

// sample received utility
export const sampleReceivedWebhook = async ({
  testID,
  external_product_sku,
  third_party_order_id,
  external_sample_id,
  external_report_id,
  electronic_order_id,
  bundle_id,
  crelioSupportEntity,
  AccessionDate,
  billId,
  labId,
  CentreReportId
}: any) => {
  //check product sku exists or not
  if (testID && testID.length > 0 && !testID.includes(external_product_sku)) {
    // check product sku exists or not
    const condition = `SI.product_supplier_sku = ?`;
    const [product] = await Products.getProductWithSupplierInfo(condition, [external_product_sku]);
    if (isEmpty(product)) throw new ClientError({ message: `Product with ${external_product_sku} not found` });

    // get status mapping details for in_transit_to_lab
    const sampleReceivedStatus = (await StatusMapping.getBys({ stage_type_id: 3, status_key: 'sample_received' }))[0];
    if (!sampleReceivedStatus)
      throw new ClientError({
        message: `You provided a specimen status of (sample_received) which is not mapped to our specimen statuses. Cannot proceed.`
      });

    // get status details for in_transit_to_lab
    const arrivedAtLabStatus = (await Status.getBys({ stage_type_id: 3, status_label: 'Arrived at Lab' }))[0];
    if (!arrivedAtLabStatus)
      throw new ClientError({
        message: `You provided a specimen status of (arrived_at_lab) which is not mapped to our specimen statuses. Cannot proceed.`
      });

    // create kit record
    const kit = {
      third_party_order_id,
      status_mapping_id: sampleReceivedStatus.id,
      internal_kit_status_mapping_id: arrivedAtLabStatus.id,
      type: 'sample',
      status: 'sample_received'
    };
    const { insertId: kitId } = await Kits.create(kit);

    // create sample record
    const sample = {
      sample_id: external_sample_id,
      kit_id: kitId,
      status: 'arrived_at_lab',
      status_mapping_id: sampleReceivedStatus.id,
      external_id: external_sample_id,
      order_id: electronic_order_id,
      bundle_id
    };
    const { insertId: sample_id } = await Samples.create(sample);

    // Update Sample_Event_History Table
    const sampleEventHistoryData = {
      sample_id,
      status: 'arrived_at_lab',
      external_status_mapping_id: sampleReceivedStatus.id,
      internal_status_mapping_id: arrivedAtLabStatus.id
    };
    await SampleEventHistory.create(sampleEventHistoryData);

    if (CentreReportId && CentreReportId.includes(Number(external_report_id))) {
      // create report record
      const reportData = {
        report_id: external_report_id,
        external_id: external_report_id,
        sample_id
      };
      await Reports.create(reportData);
    }

    // get shipment and test assignment details
    const [shipmentProductsMapping] = await ShipmentProductsMapping.getBys({
      order_id: electronic_order_id,
      bundle_id,
      product_id: product.product_id
    });
    if (shipmentProductsMapping && Object.keys(shipmentProductsMapping).length) {
      const { shipment_id, shipment_test_assignment_id } = shipmentProductsMapping;

      // update shipment status
      await updateShipmentAndEventHistory(
        shipment_id,
        'arrived_at_lab',
        sampleReceivedStatus.id,
        arrivedAtLabStatus.id,
        new Date()
      );

      // update order status
      const orderUpdate = {
        updated_at: new Date(),
        internal_order_status_mapping_id: arrivedAtLabStatus.id,
        external_order_status_mapping_id: sampleReceivedStatus.id
      };
      await Orders.update(orderUpdate, { id: electronic_order_id });
      const orderEventHistoryData = {
        electronic_order_id,
        external_status_mapping_id: sampleReceivedStatus.id,
        internal_status_mapping_id: arrivedAtLabStatus.id,
        status: 'arrived_at_lab'
      };
      await OrderEventHistory.createOrderEventHistory(orderEventHistoryData);

      // update test assignment details
      const crelioConnector = await ConnectorsBySupportEntity.getBys({ support_entity_id: crelioSupportEntity.id });
      if (crelioConnector && Object.keys(crelioConnector).length > 0) {
        const { id: ConnectorSupportEntityID } = crelioConnector;
        if (shipment_test_assignment_id) {
          await TestAssignments.update(
            {
              accession_date: AccessionDate,
              lab_invoice_id: billId,
              lab_id: labId,
              support_entity_id: crelioSupportEntity.id,
              connector_support_entity_id: ConnectorSupportEntityID
            },
            { id: shipment_test_assignment_id }
          );
        }
      }
    }
  } else {
    throw new ClientError({ message: `External product SKU ${testID} not found` });
  }
};

// sample dismissed utility
export const sampleDismissedWebhook = async ({
  testID,
  external_product_sku,
  electronic_order_id,
  bundle_id,
  external_sample_id
}: any) => {
  if (testID && testID.length > 0 && !testID.includes(external_product_sku)) {
    // check product sku exists or not
    const condition = `SI.product_supplier_sku = ?`;
    const [product] = await Products.getProductWithSupplierInfo(condition, [external_product_sku]);
    if (isEmpty(product)) throw new ClientError({ message: `Product with ${external_product_sku} not found` });

    // get shipment and test assignment details
    // get shipment and test assignment details
    const [shipmentProductsMapping] = await ShipmentProductsMapping.getBys({
      order_id: electronic_order_id,
      bundle_id,
      product_id: product.product_id
    });
    if (shipmentProductsMapping && Object.keys(shipmentProductsMapping).length) {
      const { shipment_id } = shipmentProductsMapping;

      // get status mapping details for in_transit_to_lab
      const sampleDismissedStatus = (
        await StatusMapping.getBys({ stage_type_id: 3, status_key: 'sample_dismissed' })
      )[0];
      if (!sampleDismissedStatus)
        throw new ClientError({
          message: `You provided a specimen status of (sample_dismissed) which is not mapped to our specimen statuses. Cannot proceed.`
        });

      // get status mapping details for in_transit_to_lab
      const arrivedAtLabStatus = (await StatusMapping.getBys({ stage_type_id: 3, status_key: 'arrived_at_lab' }))[0];
      if (!arrivedAtLabStatus)
        throw new ClientError({
          message: `You provided a specimen status of (arrived_at_lab) which is not mapped to our specimen statuses. Cannot proceed.`
        });

      // update sample status
      const [sampleRecord] = await Samples.getBys({ external_id: external_sample_id });

      // update sample status
      await Samples.update(
        { status: 'sample_dismissed', status_mapping_id: sampleDismissedStatus.id },
        { id: sampleRecord.id }
      );
      // Update Sample_Event_History Table
      const sampleEventHistory = {
        sample_id: sampleRecord.id,
        status: 'sample_dismissed',
        external_status_mapping_id: sampleDismissedStatus.id,
        internal_status_mapping_id: arrivedAtLabStatus.id
      };
      await SampleEventHistory.create(sampleEventHistory);

      // update shipment status
      await updateShipmentAndEventHistory(
        shipment_id,
        'arrived_at_lab',
        sampleDismissedStatus.id,
        arrivedAtLabStatus.id,
        new Date()
      );

      // update order status
      const orderUpdate = {
        updated_at: new Date(),
        internal_order_status_mapping_id: arrivedAtLabStatus.id,
        external_order_status_mapping_id: sampleDismissedStatus.id
      };
      await Orders.update(orderUpdate, { id: electronic_order_id });
      const orderEventHistoryData = {
        electronic_order_id,
        external_status_mapping_id: sampleDismissedStatus.id,
        internal_status_mapping_id: arrivedAtLabStatus.id,
        status: 'arrived_at_lab'
      };
      await OrderEventHistory.createOrderEventHistory(orderEventHistoryData);

      // to get all workflow manager data
      const users = await Users.getUsersByIn('user_role', ['5']);
      if (users && users.length > 0) {
        const filteredUsers = users.filter((item: any) => {
          return item.email && item?.manager_privilege?.split(',').map(Number).includes(2);
        });
        // send email notification for Global admins and API Managers for newly inclusion of products
        for (const { id } of filteredUsers) {
          // create workflow task
          await Tasks.createTask({
            status: 1,
            task_message: `An issue was detected with the sample ${external_product_sku}. Sample is Dismissed. Please take the necessary action.`,
            task_type_id: 7,
            shipment_id,
            user_id: id
          });
        }
      }
    }
  } else {
    throw new ClientError({ message: `External product SKU ${testID} not found` });
  }
};

// test dismissed
export const testDismissedWebhook = async ({ testID, external_product_sku, electronic_order_id, bundle_id }: any) => {
  if (testID && testID.length > 0 && !testID.includes(external_product_sku)) {
    // check product sku exists or not
    const condition = `SI.product_supplier_sku = ?`;
    const [product] = await Products.getProductWithSupplierInfo(condition, [external_product_sku]);
    if (isEmpty(product)) throw new ClientError({ message: `Product with ${external_product_sku} not found` });

    // get shipment and test assignment details
    const [shipmentProductsMapping] = await ShipmentProductsMapping.getBys({
      order_id: electronic_order_id,
      bundle_id,
      product_id: product.product_id
    });
    if (shipmentProductsMapping && Object.keys(shipmentProductsMapping).length) {
      const { shipment_id } = shipmentProductsMapping;

      // get status mapping details for in_transit_to_lab
      const testDismissedStatus = (await StatusMapping.getBys({ stage_type_id: 3, status_key: 'test_dismissed' }))[0];
      if (!testDismissedStatus)
        throw new ClientError({
          message: `You provided a specimen status of (test_dismissed) which is not mapped to our specimen statuses. Cannot proceed.`
        });

      // get status mapping details for arrived_at_lab
      const arrivedAtLabStatus = (await StatusMapping.getBys({ stage_type_id: 3, status_key: 'arrived_at_lab' }))[0];
      if (!arrivedAtLabStatus)
        throw new ClientError({
          message: `You provided a specimen status of (arrived_at_lab) which is not mapped to our specimen statuses. Cannot proceed.`
        });

      // update shipment status
      await updateShipmentAndEventHistory(
        shipment_id,
        'arrived_at_lab',
        testDismissedStatus.id,
        arrivedAtLabStatus.id,
        new Date()
      );

      // update order status
      const orderUpdate = {
        updated_at: new Date(),
        internal_order_status_mapping_id: arrivedAtLabStatus.id,
        external_order_status_mapping_id: testDismissedStatus.id
      };
      await Orders.update(orderUpdate, { id: electronic_order_id });
      const orderEventHistoryData = {
        electronic_order_id,
        external_status_mapping_id: testDismissedStatus.id,
        internal_status_mapping_id: arrivedAtLabStatus.id,
        status: 'arrived_at_lab'
      };
      await OrderEventHistory.createOrderEventHistory(orderEventHistoryData);

      // to get all workflow manager data
      const users = await Users.getUsersByIn('user_role', ['5']);
      if (users && users.length > 0) {
        const filteredUsers = users.filter((item: any) => {
          return item.email && item?.manager_privilege?.split(',').map(Number).includes(2);
        });
        // send email notification for Global admins and API Managers for newly inclusion of products
        for (const { id } of filteredUsers) {
          // create workflow task
          await Tasks.createTask({
            status: 1,
            task_message: `An issue was detected with the test ${external_product_sku}. Test is Dismissed. Please take the necessary action.`,
            task_type_id: 7,
            shipment_id,
            user_id: id
          });
        }
      }
    }
  } else {
    throw new ClientError({ message: `External product SKU ${testID} not found` });
  }
};

// webhook for report submit
export const reportSubmitWebhook = async ({
  reportFormatAndValues,
  data,
  user,
  external_report_id,
  electronic_order_id
}: any) => {
  if (reportFormatAndValues && reportFormatAndValues.length > 0) {
    const {
      reportFormat: {
        criticalLowerFemale,
        criticalLowerMale,
        criticalUpperFemale,
        criticalUpperMale,
        descriptionFlag,
        highlightFlag,
        lowerBoundFemale,
        lowerBoundMale,
        upperBoundFemale,
        upperBoundMale,
        Gender,
        Age
      }
    } = reportFormatAndValues[0];
    console.log("Hi this is _____________________________")
    const updateReport = {
      crelio_signing_doctor_name: JSON.stringify(data['Signing Doctor']),
      crelio_highlight_flag: highlightFlag,
      crelio_description_flag: descriptionFlag,
      crelio_low_critical: Gender === 'Male' ? criticalLowerMale : criticalLowerFemale,
      crelio_high_critical: Gender === 'Male' ? criticalUpperMale : criticalUpperFemale,
      crelio_report_approval_date: data['Approval Date'],
      crelio_age: Age,
      crelio_DOB: user.dob,
      crelio_lowerbound: Gender === 'Male' ? lowerBoundMale : lowerBoundFemale,
      crelio_upperbound: Gender === 'Male' ? upperBoundMale : upperBoundFemale,
      date_received: moment().format('YYYY-MM-DD HH:mm:ss')
    };
    // update report values
    await Reports.update(updateReport, { external_id: external_report_id });
    await caseManagementHandler(LAB_NAMES.CRELIO,data)
    console.log("end=============================")

    // Update order status
    // get all bundles products report details for test result received
    const reportsData = await Orders.getReportByElectronicOrderId(electronic_order_id);
    if (reportsData && reportsData.length > 0) {
      // Update order status with reports data availability
      // get all reports are received or not
      const allReportsReceived = reportsData.every((item: any) => {
        return item.date_received;
      });

      // to check if all reports are received
      if (allReportsReceived) {
        // get status details for test_results_received
        const internalTestResultsReceivedStatus = (
          await Status.getBys({ stage_type_id: 3, status_label: 'Test Results Received' })
        )[0];
        if (!internalTestResultsReceivedStatus)
          throw new ClientError({
            message: `You provided a specimen status of (test_results_received) is not found. Cannot proceed.`
          });

        // get status mapping details for test_results_received
        const externalTestResultsReceivedStatus = (
          await StatusMapping.getBys({ stage_type_id: 3, status_key: 'test_results_received' })
        )[0];
        if (!externalTestResultsReceivedStatus)
          throw new ClientError({
            message: `You provided a specimen status of (test_results_received) which is not mapped to our specimen statuses. Cannot proceed.`
          });

        // update order status with Test Results Received
        const orderUpdate = {
          updated_at: new Date(),
          internal_order_status_mapping_id: internalTestResultsReceivedStatus.id,
          external_order_status_mapping_id: externalTestResultsReceivedStatus.id
        };
        await Orders.update(orderUpdate, { id: electronic_order_id });

        // add order event history
        const orderEventHistoryData = {
          electronic_order_id,
          external_status_mapping_id: externalTestResultsReceivedStatus.id,
          internal_status_mapping_id: internalTestResultsReceivedStatus.id,
          status: 'test_results_received'
        };
        await OrderEventHistory.createOrderEventHistory(orderEventHistoryData);
      } else {
        // get status details for partial_results_received
        const internalPartialResultsReceivedStatus = (
          await Status.getBys({ stage_type_id: 3, status_label: 'Partial Results Received' })
        )[0];

        if (!internalPartialResultsReceivedStatus)
          throw new ClientError({
            message: `You provided a specimen status of (partial_results_received) is not found. Cannot proceed.`
          });

        // get status mapping details for partial_results_received
        const externalPartialResultsReceivedStatus = (
          await StatusMapping.getBys({ stage_type_id: 3, status_key: 'partial_results_received' })
        )[0];
        if (!externalPartialResultsReceivedStatus)
          throw new ClientError({
            message: `You provided a specimen status of (partial_results_received) which is not mapped to our specimen statuses. Cannot proceed.`
          });

        // update order status with Partial Results Received
        const orderUpdate = {
          updated_at: new Date(),
          internal_order_status_mapping_id: internalPartialResultsReceivedStatus.id,
          external_order_status_mapping_id: externalPartialResultsReceivedStatus.id
        };
        await Orders.update(orderUpdate, { id: electronic_order_id });

        // add order event history
        const orderEventHistoryData = {
          electronic_order_id,
          external_status_mapping_id: externalPartialResultsReceivedStatus.id,
          internal_status_mapping_id: internalPartialResultsReceivedStatus.id,
          status: 'partial_results_received'
        };
        await OrderEventHistory.createOrderEventHistory(orderEventHistoryData);
      }
    }
  }
};

// webhook for report submit PDF
export const updateReportSubmitPDFWebhook = async ({
  id,
  reportBase64,
  orderDetail: { electronic_order_id, bundle_id, external_product_sku, external_report_id, reportDate }
}: any) => {
  // create file path on s3 storage
  const filePath = `reports/${electronic_order_id}/${bundle_id}/${external_product_sku}/${external_report_id}.pdf`;
  // upload to s3
  await uploadFileToS3({
    path: filePath,
    file: Buffer.from(reportBase64, 'base64')
  });
  // to update report by id
  await Reports.update(
    {
      pdf: filePath,
      result: JSON.stringify(reportBase64),
      date_received: moment().format('YYYY-MM-DD HH:mm:ss'),
      date_resulted: moment(reportDate).format('YYYY-MM-DD HH:mm:ss')
    },
    { id }
  );

  // get all bundles products report details for test result received
  const reportsData = await Orders.getReportByElectronicOrderId(electronic_order_id);
  if (reportsData && reportsData.length > 0) {
    // Update order status with reports data availability
    // get all reports are received or not
    const allReportsReceived = reportsData.every((item: any) => {
      return item.date_received;
    });

    // to check if all reports are received
    if (allReportsReceived) {
      // get status details for test_results_received
      const internalTestResultsReceivedStatus = (
        await Status.getBys({ stage_type_id: 3, status_label: 'Test Results Received' })
      )[0];
      if (!internalTestResultsReceivedStatus)
        throw new ClientError({
          message: `You provided a specimen status of (test_results_received) is not found. Cannot proceed.`
        });

      // get status mapping details for test_results_received
      const externalTestResultsReceivedStatus = (
        await StatusMapping.getBys({ stage_type_id: 3, status_key: 'test_results_received' })
      )[0];
      if (!externalTestResultsReceivedStatus)
        throw new ClientError({
          message: `You provided a specimen status of (test_results_received) which is not mapped to our specimen statuses. Cannot proceed.`
        });

      // update order status with Test Results Received
      const orderUpdate = {
        updated_at: new Date(),
        internal_order_status_mapping_id: internalTestResultsReceivedStatus.id,
        external_order_status_mapping_id: externalTestResultsReceivedStatus.id
      };
      await Orders.update(orderUpdate, { id: electronic_order_id });

      // add order event history
      const orderEventHistoryData = {
        electronic_order_id,
        external_status_mapping_id: externalTestResultsReceivedStatus.id,
        internal_status_mapping_id: internalTestResultsReceivedStatus.id,
        status: 'test_results_received'
      };
      await OrderEventHistory.createOrderEventHistory(orderEventHistoryData);
    } else {
      // get status details for partial_results_received
      const internalPartialResultsReceivedStatus = (
        await Status.getBys({ stage_type_id: 3, status_label: 'Partial Results Received' })
      )[0];

      if (!internalPartialResultsReceivedStatus)
        throw new ClientError({
          message: `You provided a specimen status of (partial_results_received) is not found. Cannot proceed.`
        });

      // get status mapping details for partial_results_received
      const externalPartialResultsReceivedStatus = (
        await StatusMapping.getBys({ stage_type_id: 3, status_key: 'partial_results_received' })
      )[0];
      if (!externalPartialResultsReceivedStatus)
        throw new ClientError({
          message: `You provided a specimen status of (partial_results_received) which is not mapped to our specimen statuses. Cannot proceed.`
        });

      // update order status with Partial Results Received
      const orderUpdate = {
        updated_at: new Date(),
        internal_order_status_mapping_id: internalPartialResultsReceivedStatus.id,
        external_order_status_mapping_id: externalPartialResultsReceivedStatus.id
      };
      await Orders.update(orderUpdate, { id: electronic_order_id });

      // add order event history
      const orderEventHistoryData = {
        electronic_order_id,
        external_status_mapping_id: externalPartialResultsReceivedStatus.id,
        internal_status_mapping_id: internalPartialResultsReceivedStatus.id,
        status: 'partial_results_received'
      };
      await OrderEventHistory.createOrderEventHistory(orderEventHistoryData);
    }
  }
};

// To compare gdt products with crelio products and return available and removed products
export const compareGDTCrelioProduct = (
  gdtProducts: CrelioProduct[],
  crelioProducts: CrelioTestProduct[],
  gdtBundles: GDTBundle[]
): CompareResult => {
  const newProducts: CrelioTestProduct[] = [];
  const removedProducts: CrelioProduct[] = [];
  const newBundles: GDTBundle[] = [];
  const removedBundles: GDTBundle[] = [];

  // Check for records in crelioProducts that are not in gdtProducts
  crelioProducts.forEach(({ testID, testName }) => {
    // Check if the identifier is not in the Set of gdt product identifiers
    const matchFound = gdtProducts.some(
      product =>
        product.product_supplier_sku === testID?.toString() ||
        (product.product_supplier_sku === null &&
          product.name?.trim().replace(/[-_]/g, '') === testName?.trim().replace(/[-_]/g, ''))
    );

    if (!matchFound) {
      newProducts.push({ testName, testID, status: BUNDLE_PRODUCT_STATUS_MAPPING.AVAILABLE_FOR_INCLUSION }); // Add unmatched crelioProducts to newProducts
    }
  });

  // Check for records in gdtProducts that are not in crelioProducts
  gdtProducts.forEach(product => {
    // Check if the identifier is not in the Set of gdt product identifiers
    const matchFound = crelioProducts.some(
      test =>
        product.product_supplier_sku === test.testID?.toString() ||
        (product.product_supplier_sku === null &&
          product.name?.trim().replace(/[-_]/g, '') === test.testName?.trim().replace(/[-_]/g, ''))
    );

    if (!matchFound) {
      removedProducts.push(product); // Add unmatched gdtProducts to removedProducts
    }
  });

  // Compare bundles
  if (crelioProducts && gdtBundles) {
    // Check for new bundles
    crelioProducts.forEach((gdtBundle: CrelioTestProduct) => {
      const bundleExists = gdtBundles.some(
        (existingBundle: GDTBundle) =>
          existingBundle.bundle_name.trim().toLowerCase() === gdtBundle.testName.trim().toLowerCase()
      );
      if (!bundleExists) {
        newBundles.push({
          bundle_name: gdtBundle.testName,
          bundle_sku: gdtBundle.testID,
          status: BUNDLE_PRODUCT_STATUS_MAPPING.AVAILABLE_FOR_INCLUSION
        });
      }
    });

    // Check for removed bundles
    gdtBundles.forEach((existingBundle: GDTBundle) => {
      const bundleExists = crelioProducts.some(
        (gdtBundle: CrelioTestProduct) =>
          gdtBundle.testName.trim().toLowerCase() === existingBundle.bundle_name.trim().toLowerCase() &&
          gdtBundle.testID === existingBundle.bundle_sku
      );
      if (!bundleExists) {
        removedBundles.push(existingBundle);
      }
    });
  }

  return { newProducts, removedProducts, newBundles, removedBundles };
};

// to insert products and bundles with supplier info and bundle_products_mapping
export const insertProductsBundlesFromCrelio = async (
  newProducts: CrelioTestProduct[],
  newBundles: GDTBundle[],
  labId: number,
  warehouse_id: number
) => {
  if (!isEmpty(newProducts)) {
    // Insert into products table
    // status: BUNDLE_PRODUCT_STATUS_MAPPING.AVAILABLE_FOR_INCLUSION

    const productInsertQuery = `INSERT INTO products (name, status, support_entity_id_lab, support_entity_id) VALUES ${newProducts.map(() => '(?, ?, ?, ?)').join(', ')}`;
    const productValues = newProducts.flatMap(item => [item.testName, item.status, labId, warehouse_id]);
    await DB.query(productInsertQuery, productValues);

    // Insert into products settings table
    const productSettingsInsertQuery = ` INSERT INTO product_settings (product_id, prod_purc_req, bulk_shipment, indiv_shipment, obs_req_test_purc, obs_alw_test_purc, obs_alw_no_test_purc) VALUES ${newProducts
      .map(() => '((SELECT id FROM products WHERE name = ? LIMIT 1), ?, ?, ?, ?, ?, ?)')
      .join(', ')};`;
    const productSettingsValues = newProducts.flatMap(item => [item.testName, 1, 1, 1, 1, 0, 0]);
    await DB.query(productSettingsInsertQuery, productSettingsValues);

    // Insert into support entity products mapping
    const supportEntityProductsMappingsInsertQuery = ` INSERT INTO support_entity_products_mapping (product_id, support_entity_id, support_entity_sku) VALUES ${newProducts
      .map(() => '((SELECT id FROM products WHERE name = ? LIMIT 1), ?, ?)')
      .join(', ')};`;
    const supportEntityProductsMappingsValues = newProducts.flatMap(item => [item.testName, warehouse_id, '10000']);
    await DB.query(supportEntityProductsMappingsInsertQuery, supportEntityProductsMappingsValues);

    // Insert into supplier_info table
    const supplierInfoInsertQuery = ` INSERT INTO supplier_info (product_supplier_sku, product_id) VALUES ${newProducts
      .map(() => '(?, (SELECT id FROM products WHERE name = ? LIMIT 1))')
      .join(', ')};`;
    const supplierInfoValues = newProducts.flatMap(item => [item.testID, item.testName]);
    await DB.query(supplierInfoInsertQuery, supplierInfoValues);
  }

  if (!isEmpty(newBundles)) {
    // Insert into bundle table
    const bundleInsertQuery = ` INSERT INTO bundles (bundle_name, status, bundle_sku) VALUES ${newBundles.map(() => '(?, ?, ?)').join(', ')};`;
    const bundleValues = newBundles.flatMap(item => [item.bundle_name, item.status, item.bundle_sku]);
    await DB.query(bundleInsertQuery, bundleValues);

    // Insert into bundle_product table
    const bundleProductInsertQuery = ` INSERT INTO bundle_products_mapping (bundle_id, product_id) VALUES ${newBundles
      .map(
        () =>
          '((SELECT id FROM bundles WHERE bundle_name = ? LIMIT 1), (SELECT id FROM products WHERE name = ? LIMIT 1))'
      )
      .join(', ')};`;
    const bundleProductValues = newBundles.flatMap(item => [item.bundle_name, item.bundle_name]);
    await DB.query(bundleProductInsertQuery, bundleProductValues);
  }
};
