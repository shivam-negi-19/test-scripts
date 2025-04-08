/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { NextFunction, Request, Response } from 'express';
import { isEmpty } from 'lodash';
import moment from 'moment';
import logger from '../logger';
import { DB } from '../config/db';
import { ClientError } from '../error';
import { enqueueEmail, getFileSignedUrl, getMessageTypeIdByStatusKey, getUserName, processNotifications, uploadFileToS3 } from '../helpers';
import { DATE, HTTP_CODES, SHIPMENT_TYPE_ID, STAGE_TYPE, STATUSES, WORD_MAP } from '../constants';
import { generateRandomString } from '../utils';
import { Interfax } from '../integrations';
import { GlobalSetting, ReceiveFax } from '../types';
import {
  Accounts,
  BundleProductsMapping,
  Bundles,
  CarrierCodes,
  EmailQueue,
  Faxes,
  FaxStatusCodes,
  GlobalSettings,
  Orders,
  Reports,
  SampleEventHistory,
  Samples,
  ShipmentEventHistory,
  Shipments,
  Status,
  StatusMapping,
  SupportEntity,
  UserPurchases,
  Users,
  UsersByAccount
} from '../model';
import { reportSubmit, reportSubmitPDF, sampleDismissed, sampleReceived, testDismissed } from '../helpers';
import axios from 'axios';
import pdfParse from 'pdf-parse';
import crypto from 'crypto';
import { caseManagementHandler } from '../helpers/caseManagement';
import { LAB_NAMES } from '../validations';
const { PHP_URL, ALERT_MAIL } = process.env;

export const webhook = async (request: Request, response: Response, next: NextFunction) => {
  await DB.begin();
  try {
    const payload = request.body;
    const webhookType = request.query.webhook_type as string;
    const globalSettings: GlobalSetting = await GlobalSettings.getGlobalSettings();
    if (webhookType.toLowerCase() === 'shipment') {
      const shipment = await Shipments.getByIdOrExternalId(payload.shipment.shipment_id);
      if (isEmpty(shipment))
        throw new ClientError({ message: 'Invalid Shipment Id, No Shipment found for the given shipment_id' });
      const order = await Orders.getOrderByShipmentId(shipment.id);
      if (!isEmpty(order)) {
        const { account_id, user_id, electronic_order_id } = order;
        const account = await Accounts.getAccountByIdOrExternalId(account_id);
        if (isEmpty(account)) throw new ClientError({ message: `Account with ID (${account_id}) does not exists.` });
        if (isEmpty(account.is_account_active))
          throw new ClientError({
            message: `Recipient with internal ID ${account_id} (order ${electronic_order_id}) is in an inactive account. Cannot transmit shipping information.`
          });
        const user = await Users.getUserBy(account.account_id, 'id', user_id);
        if (isEmpty(user)) throw new ClientError({ message: `User with ID (${user_id}) does not exists.` });
        if (isEmpty(user.active))
          throw new ClientError({
            message: `Recipient matching assignee with internal ID ${user.id} is inactive. Cannot transmit shipment`
          });
      }
      const status_key: string = payload.shipment.current_status.toLowerCase();
      const [status] = await StatusMapping.getBys({ stage_type_id: 1, status_key });
      if (isEmpty(status))
        throw new ClientError({
          message: `You provided a shipment status of (${payload.current_status}) which is not mapped to our shipment statuses. Cannot proceed.`
        });
      const shipmentData: { [key: string]: any } = {
        status: payload.shipment.current_status.toLowerCase(),
        shipment_date: payload.shipment.update_date
          ? moment(payload.update_date).format(DATE.LONG)
          : moment().format(DATE.LONG),
        external_shipment_status_mapping_id: status.id,
        shipping_type: payload.shipment.shipping_type,
        shipment_response: JSON.stringify(payload),
        ...(payload.tracking_id && { shipment_tracking_id: payload.tracking_id }),
        ...(payload.carrier_code && { carrier_code: payload.carrier_code })
      };
      await Shipments.update(shipmentData, { id: payload.shipment.id });
      const shipmentEventHistoryData = {
        shipment_id: shipment.id,
        external_status_mapping_id: status.id,
        status: payload.shipment.current_status.toLowerCase(),
        created: payload.shipment.update_date
          ? moment(payload.update_date).format(DATE.LONG)
          : moment().format(DATE.LONG)
      };
      await ShipmentEventHistory.create(shipmentEventHistoryData);
      const user = await Shipments.getAccountByExternalShipmentId(payload.shipment_id);
      const templateId = getMessageTypeIdByStatusKey(payload.shipment.current_status.toLowerCase());
      if (!templateId) throw new ClientError({ message: 'Template Id not found.' });
      const replacements = {
        name: user.name,
        assignee_name: user.name,
        text_choice_for_product_singular: WORD_MAP[globalSettings.default_word] || '',
        app_name: globalSettings?.app_name ?? ''
      };
      await enqueueEmail({
        messageId: user.messaging_id,
        templateId,
        email: user.email,
        name: user.name,
        relationId: shipment.id,
        replacements
      });
    } else {
      console.log(payload)

      // const order = await Orders.getBy('external_id', payload.order_id);
      // if (isEmpty(order)) throw new ClientError({ message: 'Invalid Order Id, No Order found for the given order_id' });
      // const status_key: string = payload.specimen.specimen_status.toLowerCase();
      // const [status] = await StatusMapping.getBys({ stage_type_id: 1, status_key });
      // if (isEmpty(status))
      //   throw new ClientError({
      //     message: `You provided a shipment status of (${payload.specimen.specimen_status}) which is not mapped to our shipment statuses. Cannot proceed.`
      //   });
      // const userPurchases = await UserPurchases.getUserPurchases(order.id);
      // if (isEmpty(userPurchases))
      //   throw new ClientError({ message: 'Invalid Order Id, No Order found for the given order_id' });
      // const account_id: number = userPurchases[0].account_id;
      // const account = await Accounts.getById(account_id);
      // if (!account) throw new ClientError({ message: `Account (${account_id}) does not exist. Cannot proceed.` });
      // if (!account.active) throw new ClientError({ message: `Account (${account_id}) is not active` });
      // const assigneeId = payload.assignee_id;
      // const assignee = await Users.getUserBy(account_id, 'id', assigneeId);
      // if (isEmpty(assignee))
      //   throw new ClientError({
      //     message: `Assignee with ID ${assigneeId} could not be found. Cannot receive test results.`
      //   });
      // if (!assignee.active)
      //   throw new ClientError({ message: `Assignee with ID ${assigneeId} is inactive. Cannot receive test results.` });
      // if (!assignee.account_active)
      //   throw new ClientError({
      //     message: `Assignee with ID ${assigneeId} is in an inactive account. Cannot receive test results.`
      //   });
      // const [bundle] = await Bundles.getBundlesBySKUs([payload.bundle_sku]);
      // let sample_id = await Samples.getBy('sample_id', payload.specimen.specimen_id);
      // if (sample_id !== undefined) {
      //   await Samples.update({ status: payload.specimen.specimen_status }, { sample_id: sample_id.id });
      // } else {
      //   const sampleData = {
      //     sample_id: payload.specimen.specimen_id,
      //     status: payload.report_result.specimen_status,
      //     status_mapping_id: status.id,
      //     external_id: generateRandomString(),
      //     order_id: order.id,
      //     bundle_id: bundle.id
      //   };
      //   sample_id = (await Samples.create(sampleData))?.insertId;
      // }
      // sample_id = sample_id.id;
      // const sampleEventHistoryData = {
      //   sample_id,
      //   status: payload.specimen.specimen_status,
      //   external_status_mapping_id: status.id,
      //   internal_status_mapping_id: status.id
      // };
      // await SampleEventHistory.create(sampleEventHistoryData);

      const reports = payload.specimen.reports;
      // console.log("These are the repors of speciman",payload.specimen)

      // for (const report of reports) {
      //   console.log("********************************");
      //   console.log(report.report_result);
      //   console.log("********************************");
      // }
      console.log("Entering case management handler");
       caseManagementHandler(LAB_NAMES.SPOTDX,payload.specimen)
            console.log("Exit case management handler");


      // for (const report of reports) {
      //   if (!report.report_pdf.toLowerCase().endsWith('.pdf')) {
      //     throw new ClientError({ message: 'Invalid PDF URL. Please provide a valid PDF file.' });
      //   }
      //   const response = await axios.get(report.report_pdf, { responseType: 'arraybuffer' });
      //   const pdfData = await pdfParse(response.data);
      //   const reportData = {
      //     sample_id,
      //     report_id: report.report_id,
      //     pdf: report.report_pdf,
      //     txt: report.report_txt,
      //     date_collected: moment(report.collection_date_time).format(DATE.LONG),
      //     date_received: moment(report.received_date_time).format(DATE.LONG),
      //     date_resulted: moment(report.resulted_date_time).format(DATE.LONG),
      //     is_amendment: report.is_revision === 'yes' ? 1 : 0,
      //     visible_to_provider: report.visible_to_provider !== undefined ? report.visible_to_provider : 1,
      //     visible_to_patient: report.visible_to_patient !== undefined ? report.visible_to_patient : 1,
      //     provider_notified_date_time: report.provider_notified_date_time || null,
      //     patient_notified_date_time: report.patient_notified_date_time || null,
      //     viewed_by_provider_date_time: report.viewed_by_provider_date_time || null,
      //     released_by_provider_date_time: report.released_by_provider_date_time || null,
      //     viewed_by_patient_date_time: report.viewed_by_patient_date_time || null,
      //     result: pdfData.text.trim()
      //   };
      //   const { bundle_id } = await Samples.getById(sample_id);
      //   const { bundle_sku } = await Bundles.getById(bundle_id);
      //   const bundleProductsMapping = await BundleProductsMapping.getBy('bundle_id', bundle_id);
      //   const providerId = order.ordered_by_user_id;
      //   const providerEmail = await Users.getUserBy(account_id, 'id', providerId);
      //   const userAccountLinker = await UsersByAccount.getBys({ account_id: account_id, user_id: providerId });
      //   const accountSettings = await Accounts.getById(account_id);
      //   const { insertId } = await Reports.create(reportData);
      //   let templateId: number | null;
      //   if (bundleProductsMapping.length === report.report_result.length) templateId = 91;
      //   else if (bundleProductsMapping.length !== report.report_result.length) templateId = 92;
      //   else templateId = getMessageTypeIdByStatusKey(status_key);
      //   if (!templateId) throw new ClientError({ message: 'Template Id not found.' });
      //   type ReplacementValues = string | number | boolean | object;
      //   const replacements: { [key: string]: ReplacementValues } = {};
      //   logger.info(`Template id: ${templateId}`);
      //   const currDate = Math.floor(Date.now() / 1000); // Ensure same format
      //   const timeLimit = currDate + 30 * 24 * 60 * 60;
      //   const base_url = process.env.PHP_URL || '';
      //   const result_link = createUrl('', base_url, assignee.email, timeLimit);

      //   switch (templateId) {
      //     case 63:
      //       replacements.assignee_name = assignee.name;
      //       replacements.text_choice_for_product_singular = WORD_MAP[globalSettings.default_word] || '';
      //       break;
      //     case 64:
      //       replacements.assignee_name = assignee.name;
      //       replacements.text_choice_for_product_singular = WORD_MAP[globalSettings.default_word] || '';
      //       break;
      //     case 68:
      //       replacements.patient_data_name = assignee.name;
      //       replacements.patient_data_dob = assignee.dob;
      //       replacements.patient_data_id = assignee.user_id;
      //       replacements.patient_data_race = assignee.race;
      //       replacements.patient_data_ethnicity = assignee.ethnicity;
      //       replacements.patient_data_gender = assignee.gender;
      //       replacements.test_results_date = new Date(report.resulted_date_time).toLocaleString();
      //       replacements.test_results_number_of_new_tests_resulted = report.report_result.length;
      //       replacements.test_result_bundle_sku = bundle_sku;
      //       replacements.test_results_link = `${result_link}&report_id=${insertId}&test_results=1`;
      //       replacements.name = assignee.name;
      //       replacements.assignee_name = assignee.name;
      //       break;
      //     case 69:
      //       replacements.patient_data_name = assignee.name;
      //       replacements.patient_data_dob = assignee.dob;
      //       replacements.patient_data_id = assignee.user_id;
      //       replacements.patient_data_race = assignee.race;
      //       replacements.patient_data_ethnicity = assignee.ethnicity;
      //       replacements.patient_data_gender = assignee.gender;
      //       replacements.test_results_date = new Date(report.resulted_date_time).toLocaleString();
      //       replacements.test_results_number_of_new_tests_resulted = report.report_result.length;
      //       replacements.test_result_bundle_sku = bundle_sku;
      //       replacements.test_results_link = `${result_link}&report_id=${insertId}&test_results=1`;
      //       replacements.name = assignee.name;
      //       replacements.assignee_name = assignee.name;
      //       replacements.text_choice_for_product_singular = WORD_MAP[globalSettings.default_word] || '';
      //       break;
      //     case 70:
      //       replacements.patient_data_name = assignee.name;
      //       replacements.patient_data_dob = assignee.dob;
      //       replacements.patient_data_id = assignee.user_id;
      //       replacements.patient_data_race = assignee.race;
      //       replacements.patient_data_ethnicity = assignee.ethnicity;
      //       replacements.patient_data_gender = assignee.gender;
      //       replacements.test_results_date = new Date(report.resulted_date_time).toLocaleString();
      //       replacements.test_results_number_of_new_tests_resulted = report.report_result.length;
      //       replacements.test_result_bundle_sku = bundle_sku;
      //       replacements.test_results_link = `${result_link}&report_id=${insertId}&test_results=1`;
      //       replacements.name = assignee.name;
      //       replacements.assignee_name = assignee.name;
      //       replacements.app_name = globalSettings?.app_name ?? '';
      //       break;
      //     case 71:
      //       replacements.patient_data_name = assignee.name;
      //       replacements.patient_data_dob = assignee.dob;
      //       replacements.patient_data_id = assignee.user_id;
      //       replacements.patient_data_race = assignee.race;
      //       replacements.patient_data_ethnicity = assignee.ethnicity;
      //       replacements.patient_data_gender = assignee.gender;
      //       replacements.test_results_date = new Date(report.resulted_date_time).toLocaleString();
      //       replacements.test_results_number_of_new_tests_resulted = report.report_result.length;
      //       replacements.test_result_bundle_sku = bundle_sku;
      //       replacements.test_results_link = `${result_link}&report_id=${insertId}&test_results=1`;
      //       replacements.name = assignee.name;
      //       replacements.assignee_name = assignee.name;
      //       replacements.text_choice_for_product_singular = WORD_MAP[globalSettings.default_word] || '';
      //       break;
      //     case 72:
      //       replacements.patient_data_name = assignee.name;
      //       replacements.patient_data_dob = assignee.dob;
      //       replacements.patient_data_id = assignee.user_id;
      //       replacements.patient_data_race = assignee.race;
      //       replacements.patient_data_ethnicity = assignee.ethnicity;
      //       replacements.patient_data_gender = assignee.gender;
      //       replacements.test_results_date = new Date(report.resulted_date_time).toLocaleString();
      //       replacements.test_results_number_of_new_tests_resulted = report.report_result.length;
      //       replacements.test_result_bundle_sku = bundle_sku;
      //       replacements.test_results_link = `${result_link}&report_id=${insertId}&test_results=1`;
      //       replacements.name = assignee.name;
      //       replacements.assignee_name = assignee.name;
      //       replacements.text_choice_for_product_singular = WORD_MAP[globalSettings.default_word] || '';
      //       break;
      //     case 91:
      //       replacements.patient_data_name = assignee.name;
      //       replacements.patient_data_dob = assignee.dob;
      //       replacements.patient_data_id = assignee.user_id;
      //       replacements.patient_data_race = assignee.race;
      //       replacements.patient_data_ethnicity = assignee.ethnicity;
      //       replacements.patient_data_gender = assignee.gender;
      //       replacements.test_results_date = new Date(report.resulted_date_time).toLocaleString();
      //       replacements.test_results_number_of_new_tests_resulted = report.report_result.length;
      //       replacements.test_result_bundle_sku = bundle_sku;
      //       replacements.test_results_link = `${result_link}&report_id=${insertId}&test_results=1`;
      //       replacements.name = assignee.name;
      //       replacements.assignee_name = assignee.name;
      //       replacements.app_name = globalSettings?.app_name ?? '';
      //       break;
      //     case 92:
      //       replacements.patient_data_name = assignee.name;
      //       replacements.patient_data_dob = assignee.dob;
      //       replacements.patient_data_id = assignee.user_id;
      //       replacements.patient_data_race = assignee.race;
      //       replacements.patient_data_ethnicity = assignee.ethnicity;
      //       replacements.patient_data_gender = assignee.gender;
      //       replacements.test_results_date = new Date(report.resulted_date_time).toLocaleString();
      //       replacements.test_results_number_of_new_tests_resulted = report.report_result.length;
      //       replacements.test_result_bundle_sku = bundle_sku;
      //       replacements.test_results_link = `${result_link}&report_id=${insertId}&test_results=1`;
      //       replacements.name = assignee.name;
      //       break;
      //     case 93:
      //       replacements.patient_data_name = assignee.name;
      //       replacements.patient_data_dob = assignee.dob;
      //       replacements.patient_data_id = assignee.user_id;
      //       replacements.patient_data_race = assignee.race;
      //       replacements.patient_data_ethnicity = assignee.ethnicity;
      //       replacements.patient_data_gender = assignee.gender;
      //       replacements.test_results_date = new Date(report.resulted_date_time).toLocaleString();
      //       replacements.test_results_number_of_new_tests_resulted = report.report_result.length;
      //       replacements.test_result_bundle_sku = bundle_sku;
      //       replacements.test_results_link = `${result_link}&report_id=${insertId}&test_results=1`;
      //       replacements.name = assignee.name;
      //       break;
      //     default:
      //       break;
      //   }

      //   // Provider Receives Results First (Delay Enabled)
      //   if (
      //     providerId &&
      //     Number(accountSettings.permit_provider_to_hold_results_back_from_patients) === 1 &&
      //     Number(userAccountLinker[0].consent_for_auto_data_sharing) === 1
      //   ) {
      //     reportData.visible_to_provider = 1;
      //     reportData.visible_to_patient = 0;
      //     const { insertId } = await Reports.create(reportData);
      //     const replacement = {
      //       patient_test_results_url: `${PHP_URL}/provider?name=${encodeURIComponent(providerEmail.email)}&autoLogin=1&accountid=${account_id}&redirect_to_provider=1&report_id=${insertId}&patient_id=${assigneeId}`,
      //       app_name: globalSettings?.app_name ?? ''
      //     };
      //     await enqueueEmail({
      //       messageId: account.messaging_id,
      //       templateId: 127,
      //       email: providerEmail.email,
      //       name: providerEmail.name,
      //       relationId: sample_id,
      //       replacements: replacement
      //     });
      //   } else if (Number(accountSettings.permit_provider_to_hold_results_back_from_patients) === 0) {
      //     reportData.visible_to_provider = 1;
      //     reportData.visible_to_patient = 1;
      //     const { insertId } = await Reports.create(reportData);
      //     const replacement = {
      //       patient_test_results_url: `${PHP_URL}/provider?name=${encodeURIComponent(providerEmail.email)}&autoLogin=1&accountid=${account_id}&redirect_to_provider=1&report_id=${insertId}&patient_id=${assigneeId}`,
      //       app_name: globalSettings?.app_name ?? ''
      //     };
      //     await enqueueEmail({
      //       messageId: account.messaging_id,
      //       templateId: 127,
      //       email: providerEmail.email,
      //       name: providerEmail.name,
      //       relationId: sample_id,
      //       replacements: replacement
      //     });
      //     await enqueueEmail({
      //       messageId: account.messaging_id,
      //       templateId: templateId,
      //       email: assignee.email,
      //       name: assignee.name,
      //       relationId: sample_id,
      //       replacements: replacements
      //     });
      //   } else if (Number(userAccountLinker[0].suppress_provider_access_to_test_results) === 1) {
      //     // Results visible only to patient
      //     report.visible_to_patient = 1;
      //     report.visible_to_provider = 0;
      //     await Reports.create(reportData);
      //     await enqueueEmail({
      //       messageId: account.messaging_id,
      //       templateId: templateId,
      //       email: assignee.email,
      //       name: assignee.name,
      //       relationId: sample_id,
      //       replacements: replacements
      //     });
      //   }
      // }
    }
    await DB.commit();
    response.status(200).json({ message: 'Status Updated Successfully' });
  } catch (error) {
    await DB.rollback();
    next(error);
  }
};

export const shipheroWebhook = async (request: Request, response: Response, next: NextFunction) => {
  await DB.begin();
  try {
    const payload = request.body;
    if (payload.webhook_type !== 'Shipment Update')
      throw new ClientError({ message: 'Invalid webhook type requires Shipment Update' });
    const shipment = await Shipments.getBy('external_id', payload.fulfillment.shipment_uuid);
    if (isEmpty(shipment)) throw new ClientError({ message: 'Invalid shipment id' });
    const supportEntity = await SupportEntity.getById(shipment.support_entity_id);
    if (supportEntity.external_id !== payload.fulfillment.warehouse_uuid)
      throw new ClientError({ message: 'Invalid support entity id' });

    const status = await Status.getStatusBy({
      language_id: 1,
      support_entity_id: shipment.support_entity_id,
      'STY.id': STAGE_TYPE.SHIPMENT,
      'S.status_label': STATUSES.SHIPMENT.IN_TRANSIT
    });
    if (isEmpty(status))
      throw new ClientError({
        message: `Status '${STATUSES.SHIPMENT.IN_TRANSIT}' does not have mapping for support entity '${supportEntity.name}'`
      });
    const jsonData = JSON.stringify({
      test: payload.test,
      webhook_type: payload.webhook_type,
      fulfillment: payload.fulfillment,
      total_packages: payload.total_packages,
      packages: payload.packages
    });
    const globalSettings: GlobalSetting = await GlobalSettings.getGlobalSettings();

    const shipmentData = {
      external_shipment_status_mapping_id: status.external_status_id,
      internal_shipment_status_mapping_id: status.internal_status_id,
      shipment_date: payload.fulfillment.created_at,
      status: status.internal_status,
      total_packages: payload.fulfillment.total_packages,
      shipment_response: jsonData
    };
    await Shipments.update(shipmentData, { id: shipment.id });

    const shipmentEventHistoryData = {
      shipment_id: shipment.id,
      external_status_mapping_id: status.external_status_id,
      internal_status_mapping_id: status.internal_status_id,
      status: status.internal_status,
      created: payload.fulfillment.created_at
    };
    await ShipmentEventHistory.create(shipmentEventHistoryData);
    // TODO: update order status and order hisotry also

    const { assignee_first_name, total_assigned_test, total_assigned_observation } =
      await Shipments.getShipemntWithTestAssignment(shipment.id);
    const {
      messaging_id,
      email,
      name,
      purchaser_name,
      company_name,
      street1,
      street2,
      city_name,
      state_name,
      postal_code,
      country_name,
      carrier_codes_id
    } = await Shipments.getAccountByExternalShipmentId(shipment.external_id);
    const { carrier_code, friendly_name } = await CarrierCodes.getById(carrier_codes_id);
    const replacements = {
      ...(total_assigned_test && total_assigned_observation && { assignee_first_name }),
      purchaser_name,
      num_test_shipped_assignee: total_assigned_test,
      shipper_type: carrier_code,
      name,
      company_name,
      shipping_address_1: street1,
      shipping_address_2: street2,
      shipping_city: city_name,
      shipping_state: state_name,
      shipping_zip: postal_code,
      shipping_country: country_name,
      assignee_name: assignee_first_name,
      text_choice_for_product_singular: WORD_MAP[globalSettings.default_word] || '',
      total_quantity_shipped_individuals: total_assigned_test,
      shipping_carrier: friendly_name,
      shipping_priority: '', //TODO
      account_main_contact_name: name,
      account_name: company_name,
      shipping_tracking_number: payload.fulfillment.tracking_number
    };
    await enqueueEmail({
      messageId: messaging_id,
      templateId: 10,
      email: email,
      name: name,
      relationId: shipment.id,
      replacements
    });

    if (shipment.shipping_type === SHIPMENT_TYPE_ID.RETURN) {
      const { messaging_id, email, name } = await Shipments.getAccountByExternalShipmentId(shipment.external_id);
      const replacements = { name, assignee_name: name };
      await enqueueEmail({
        messageId: messaging_id,
        templateId: 66,
        email: email,
        name: name,
        relationId: shipment.id,
        replacements
      });
    }

    await DB.commit();
    response.status(200).json({ message: 'Shipment details updated successfully' });
  } catch (error) {
    await DB.rollback();
    next(error);
  }
};
export const recieveFax = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await DB.begin();
    logger.info('Recieving new inbound fax...');
    const recieveFaxData: ReceiveFax = req.body;
    const account = await Accounts.getAccountByFaxNumber(recieveFaxData.PhoneNumber);
    if (isEmpty(account))
      throw new ClientError({ message: `Account not found for fax number ${recieveFaxData.PhoneNumber}` });
    if (!account.enable_outbound_faxes_third_parties)
      throw new ClientError({
        message: `Account with ID (${account.account_id}) does not enable outbound faxes third parties`
      });
    await Faxes.create({
      account_id: account?.id,
      transaction_type: 1,
      transaction_id: recieveFaxData.TransactionID,
      phone_number: recieveFaxData.PhoneNumber,
      message_type: recieveFaxData.MessageType,
      remote_csid: recieveFaxData.RemoteCSID || recieveFaxData.CallerID,
      pages: recieveFaxData.Pages,
      status: recieveFaxData.Status,
      transmission_duration: recieveFaxData.RecordingDuration,
      send_or_receive_datetime: moment(recieveFaxData.ReceiveTime, 'M/D/YYYY h:mm:ss A').format(DATE.LONG),
      from_user_id: recieveFaxData.FromUserID || null,
      from_contact: recieveFaxData.FromContact,
      to_user_id: recieveFaxData.ToUserID || null,
      to_contact: recieveFaxData.ToContact,
      needs_processing: 1
    });
    const image = await Interfax.getFaxImage(recieveFaxData.TransactionID);
    const filePath = `fax_documents/inbound/${recieveFaxData.TransactionID}.pdf`;
    logger.info('Uploading the inbound fax document to s3...');
    await uploadFileToS3({
      path: filePath,
      file: image
    });
    logger.info('Updating the fax record with document url...');
    await Faxes.update({ fax_image_url: filePath }, { transaction_id: recieveFaxData.TransactionID });
    await DB.commit();
    res.status(200).json({ message: 'New Fax Received' });
  } catch (error) {
    const subject = 'Fax received failed';
    const body = `Error in receiving fax: \n\n
    Request: \n\n
    ${JSON.stringify(req.body, null, 2)} \n\n
    Error: \n\n
    ${JSON.stringify(error || '')}`;

    await EmailQueue.addEmailToQueue({
      subject,
      body,
      to_email: ALERT_MAIL,
      user_name: 'Engineering Alerts',
      relation_id: null
    });
    await DB.rollback();
    next(error);
  }
};

export const faxStatusUpdate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await DB.begin();
    const payload = req.body;
    const fax = await Faxes.getBy('transaction_id', payload.TransactionID);
    const fromUser = await Users.getUserByIdOrName(fax.from_user_id, fax.from_contact);
    if (isEmpty(fromUser)) throw new ClientError({ message: 'Sender not found!!!' });
    const toUser = await Users.getUserByIdOrName(fax.to_user_id, fax.to_contact);
    if (isEmpty(fromUser)) throw new ClientError({ message: 'Reciever not found!!!' });
    const fromName = getUserName(fromUser, fax.from_contact);
    const toName = getUserName(toUser, fax.to_contact);
    const globalSettings: GlobalSetting = await GlobalSettings.getGlobalSettings();

    if (payload.Status === 0) {
      logger.info(`Fax with transaction id ${payload.TransactionID} successfully sent...`);
      const status = await FaxStatusCodes.getBy('status_code', payload.Status);
      logger.info('Updating the fax status...');
      // successful notification for sender
      const replacements = {
        user_name: fromName,
        fax_destination_number: fax.phone_number,
        fax_recipient: getUserName(toUser, fax.to_contact),
        fax_status: payload.Status,
        verbose_fax_status: status?.message,
        app_name: globalSettings?.app_name ?? ''
      };
      await enqueueEmail({
        messageId: 8,
        templateId: 110,
        email: fromUser.email,
        name: fromName,
        relationId: fromUser.id,
        replacements
      });
      await Faxes.update(
        {
          send_or_receive_datetime: moment(payload.CompletionTime, 'DD/MM/YYYY HH:mm:ss').format(DATE.LONG),
          cost: parseInt(payload.CostPerUnit, 10) * parseInt(payload.Units, 10),
          transmission_duration: payload.Duration,
          status: payload.Status,
          verbose_status: status?.message,
          outbound_successful_sender_notification: 1,
          needs_processing: 1
        },
        { id: fax.id }
      );
      // successful notification for receiver
      const replacement = {
        user_name: toName,
        fax_sender_contact: fromName,
        fax_sender_number: fromUser.phone_number,
        fax_receive_datetime: fax.send_or_receive_datetime,
        fax_pages: fax.pages,
        app_name: globalSettings?.app_name ?? ''
      };
      await enqueueEmail({
        messageId: 8,
        templateId: 111,
        email: toUser.email,
        name: toName,
        relationId: toUser.id,
        replacements: replacement
      });
      await Faxes.update(
        {
          outbound_successful_recipient_notification: 1
        },
        { id: fax.id }
      );
    } else {
      logger.info(`Fax with transaction id ${payload.TransactionID} failed sent...`);
      const status = await FaxStatusCodes.getBy('status_code', payload.Status);
      logger.info('Updating the fax status...');
      await Faxes.update(
        {
          status: payload.Status,
          verbose_status: status?.message
        },
        { id: fax.id }
      );

      const replacements = {
        user_name: fromName,
        fax_destination_number: fax.phone_number,
        fax_recipient: getUserName(toUser, fax.to_contact),
        fax_status: payload.Status,
        verbose_fax_status: status?.message,
        app_name: globalSettings?.app_name ?? ''
      };
      await enqueueEmail({
        messageId: 8,
        templateId: 108,
        email: fromUser.email,
        name: fromName,
        relationId: fromUser.id,
        replacements
      });
    }
    await DB.commit();
    res.status(200).json({ message: 'Fax Status Updated' });
  } catch (error) {
    await DB.rollback();
    next(error);
  }
};

// Webhook for sample received from crelio
export const crelioSampleReceived = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
  await DB.begin();
  try {
    logger.info(`Received Crelio Sample Received Webhook \n ${JSON.stringify({ body: request.body })}`);
    const payload = request.body;
    await sampleReceived(payload);
    await DB.commit();
    response.status(HTTP_CODES.OK).json({ message: 'Sample Received status updated successfully' });
  } catch (error) {
    await DB.rollback();
    next(error);
  }
};

// webhook for sample dismissed from crelio
export const crelioSampleDismissed = async (
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> => {
  await DB.begin();
  try {
    logger.info(`Received Crelio Sample Dismissed Webhook \n ${JSON.stringify({ body: request.body })}`);
    const payload = request.body;
    await sampleDismissed(payload);
    await DB.commit();
    response.status(HTTP_CODES.OK).json({ message: 'Sample Dismissed status updated successfully' });
  } catch (error) {
    await DB.rollback();
    next(error);
  }
};

// webhook for test dismissed from crelio
export const crelioTestDismissed = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
  await DB.begin();
  try {
    logger.info(`Received Crelio Test Dismissed Webhook \n ${JSON.stringify({ body: request.body })}`);
    const payload = request.body;
    await testDismissed(payload);
    await DB.commit();
    response.status(HTTP_CODES.OK).json({ message: 'Test Dismissed status updated successfully' });
  } catch (error) {
    await DB.rollback();
    next(error);
  }
};

// webhook for test dismissed from crelio
export const crelioReportSubmit = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
  await DB.begin();
  try {
    logger.info(`Received Crelio Report Submit Webhook \n ${JSON.stringify({ body: request.body })}`);
    const payload = request.body;
    await reportSubmit(payload);
    await DB.commit();
    response.status(HTTP_CODES.OK).json({ message: 'Report Submit status updated successfully' });
  } catch (error) {
    await DB.rollback();
    next(error);
  }
};

// webhook for report submit pdf from crelio
export const crelioReportSubmitPDF = async (
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> => {
  await DB.begin();
  try {
    logger.info(`Received Crelio Report Submit PDF Webhook \n ${JSON.stringify({ body: request.body })}`);
    const payload = request.body;
    await reportSubmitPDF(payload);
    await DB.commit();
    response.status(HTTP_CODES.OK).json({ message: 'Report Submit PDF status updated successfully' });
  } catch (error) {
    await DB.rollback();
    next(error);
  }
};

export const getShipmentInsertUrl = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
  try {
    logger.info(`Received Get Shipment Insert Url Webhook`);
    const { id: shipmentId } = request.params;
    const shipment = await Shipments.getByIdOrExternalId(shipmentId);
    if (isEmpty(shipment)) throw new ClientError({ message: 'Invalid shipment id' });
    const shipmentInsertUrl = !isEmpty(shipment.personalized_shipment_qr_code_destination_url)
      ? await getFileSignedUrl({ path: shipment.personalized_shipment_qr_code_destination_url })
      : null;
    if (isEmpty(shipmentInsertUrl))
      throw new ClientError({ message: `No shipment insert for shipment id (${shipmentId}) available` });
    response.status(HTTP_CODES.OK).json({ shipment_insert_url: shipmentInsertUrl });
  } catch (error) {
    next(error);
  }
};

const createUrl = (privateKey: string, url: string, userName: string, timeLimit: number): string => {
  const token = createToken(privateKey, url, userName, timeLimit);

  // Proper encoding applied here
  const params = new URLSearchParams({
    name: userName,
    timeLimit: timeLimit.toString(),
    token
  });

  return `${url}?${params.toString()}`;
};

const createToken = (privateKey: string, url: string, userName: string, timeLimit: number): string => {
  return crypto.createHash('sha256').update(`${privateKey}${url}${userName}${timeLimit}`).digest('hex');
};
