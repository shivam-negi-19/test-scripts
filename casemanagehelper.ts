/* eslint-disable @typescript-eslint/no-explicit-any */
import { LAB_NAMES } from '../constants';
import { GlobalSettings } from '../model';
import { AccountSettings } from '../model/AccountSetting';
import { CaseManagement as Cases, CaseManagerLinker, CaseManagementProductsAndBundles } from '../model/CaseManagement';

import logger from '../logger';
// -----------------------------------
// UTILITY FUNCTIONS
// -----------------------------------

/**
 * Converts an ISO date string to MySQL-compatible timestamp format (YYYY-MM-DD HH:MM:SS).
 * @param isoDate - The ISO date string to convert.
 * @returns A MySQL-compatible timestamp string.
 */
function toMySQLTimestamp(isoDate: string): string {
  return new Date(isoDate).toISOString().slice(0, 19).replace('T', ' ');
}

// -----------------------------------
// RESULT ANALYSIS FUNCTIONS
// -----------------------------------

/**
 * Determines if a test result is positive or abnormal based on lab-specific logic.
 * @param labName - The name of the lab (e.g., CRELIO, SPOTDX).
 * @param result - The test result data.
 * @returns True if the result is positive or abnormal, false otherwise.
 */
export const isPositiveOrAbnormalFunc = (labName: string, result: unknown): boolean => {
  logger.info(`Analyzing result for lab: ${labName}`);
  if (!result || typeof result !== 'object') {
    logger.info('Result is invalid or not an object, returning false');
    return false;
  }
  const obj = result as Record<string, unknown>;
  switch (labName) {
    case LAB_NAMES.CRELIO:
      return analyzeCrelio(obj);
    case LAB_NAMES.SPOTDX:
      return analyzeSpotDx(obj);
    default:
      logger.info(`Unknown lab: ${labName}, returning false`);
      return false;
  }
};

/**
 * Analyzes Crelio test results for positive or abnormal conditions.
 * @param result - The Crelio test result data.
 * @returns True if the result is positive or abnormal, false otherwise.
 */
function analyzeCrelio(result: Record<string, unknown> = {}): boolean {
  logger.info('Analyzing Crelio result');
  const reportFormat = (result as Record<string, unknown>) || {};
  logger.info('Crelio reportFormat processed');

  if (typeof reportFormat.highlightFlag === 'number') {
    logger.info(`Highlight flag: ${reportFormat.highlightFlag}`);
    return reportFormat.highlightFlag === 1;
  }

  // Analyze result based on value and gender
  const num = parseFloat(result.value as string || '');
  if (isNaN(num)) {
    logger.info('Value is not a number, returning false');
    return false;
  }
  const gender = result.gender?.toString().toLowerCase();
  logger.info(`Gender: ${gender}`);
  if (gender !== 'male' && gender !== 'female') {
    logger.info('Invalid gender, returning false');
    return false;
  }
  const [lowerKey, upperKey] = gender === 'male'
    ? ['lowerBoundMale', 'upperBoundMale']
    : ['lowerBoundFemale', 'upperBoundFemale'];
  const lower = parseFloat(reportFormat[lowerKey] as string || '0');
  const upper = parseFloat(reportFormat[upperKey] as string || '0');
  logger.info(`Range: ${lower} - ${upper}, Value: ${num}`);
  return !isNaN(lower) && !isNaN(upper) && (num < lower || num > upper);
}

/**
 * Analyzes SpotDx test results for positive or abnormal conditions.
 * @param result - The SpotDx test result data.
 * @returns True if the result is positive or abnormal, false otherwise.
 */
function analyzeSpotDx(result: Record<string, unknown>): boolean {
  const resultType = result.report_type;
  const resultValue = result.result;
  logger.info(`SpotDx - Result Type: ${resultType}, Value: ${resultValue}`);
  if (resultType === 'reactivity') {
    logger.info(`Reactivity check: ${resultValue}`);
    return String(resultValue).toLowerCase() === 'positive';
  }
  if (resultType === 'genotype') {
    logger.info('Genotype check, always false');
    return false;
  }
  if (resultType === 'quantity') {
    let numericValue: number;
    let isLessThan = false;
    let isGreaterThan = false;
    if (typeof resultValue === 'number') {
      logger.info(`Numeric value: ${resultValue}`);
      numericValue = resultValue;
    } else if (typeof resultValue === 'string') {
      const trimmed = resultValue.trim();
      logger.info(`String value trimmed: ${trimmed}`);
      if (trimmed.startsWith('<')) {
        numericValue = parseFloat(trimmed.slice(1));
        isLessThan = true;
        logger.info(`Less than: ${numericValue}`);
      } else if (trimmed.startsWith('>')) {
        numericValue = parseFloat(trimmed.slice(1));
        isGreaterThan = true;
        logger.info(`Greater than: ${numericValue}`);
      } else {
        numericValue = parseFloat(trimmed);
        logger.info(`Parsed value: ${numericValue}`);
      }
      if (isNaN(numericValue)) {
        logger.info('Value is NaN, returning false');
        return false;
      }
    } else {
      logger.info('Invalid value type, returning false');
      return false;
    }
    const rangeMin = isNaN(Number(result.minimum_range)) ? null : Number(result.minimum_range);
    const rangeMax = isNaN(Number(result.maximum_range)) ? null : Number(result.maximum_range);
    logger.info(`Range: ${rangeMin} - ${rangeMax}`);
    if (rangeMin !== null && rangeMax !== null) {
      if (isLessThan) return numericValue <= rangeMin;
      if (isGreaterThan) return numericValue >= rangeMax;
      return numericValue < rangeMin || numericValue > rangeMax;
    }
  }
  logger.info('No conditions met, returning false');
  return false;
}

// -----------------------------------
// RESULT PROCESSING FUNCTIONS
// -----------------------------------

/**
 * Handles case management for a test report, creating or updating cases as needed.
 * @param report - The test report data.
 * @param case_data - Additional case-related data.
 * @returns A promise that resolves when processing is complete.
 */
export async function caseManagementHandler(report: any, case_data: any): Promise<void> {
  logger.info('Starting case management handler');
  try {
    // Insert test result into report_test_results table
    logger.info('Inserting test result into test_db_TestResults');
    if (!report.is_positive_or_abnormal) {
      logger.info('Skipping: Test result is not positive or does not need processing');
      return;
    }

    // Check if case management is enabled for the account
    logger.info(`Checking case management scope for accountId: ${case_data.account_id}`);
    const inScope = await isInCaseManagementScope(Number(case_data.account_id));
    logger.info(`In case management scope: ${inScope}`);
    if (!inScope) {
      logger.info('Skipping: Not in case management scope');
      return;
    }

    // Check for existing open case
    logger.info('Checking for existing open case');
    const existingOpenCase = await Cases.checkOpenCase(case_data.user_id);
    logger.info(`Existing open case: ${JSON.stringify(existingOpenCase)}`);

    if (existingOpenCase) {
      // Update existing case with product and bundle data
      logger.info('Updating existing case');
      const updatedCase = await updateExistingCase(case_data);
      logger.info(`Updated case: ${JSON.stringify(updatedCase)}`);
    } else {
      // Create a new case
      logger.info('Creating new case');
      const newCase = await createNewCase(case_data);
      logger.info(`New case created: ${JSON.stringify(newCase)}`);
    }

    logger.info('Case management handler completed successfully');
  } catch (error) {
    logger.error('Error processing test result', { error });
  }
}

// -----------------------------------
// CASE MANAGEMENT SUPPORT FUNCTIONS
// -----------------------------------

/**
 * Checks if case management is enabled for the given account ID.
 * @param accountId - The account ID to check.
 * @returns A promise resolving to true if case management is enabled, false otherwise.
 */
export async function isInCaseManagementScope(accountId: number): Promise<boolean> {
  // Check global settings
  const isGlobalCaseManagementEnabled = await GlobalSettings.getGlobalSettings();

  if (isGlobalCaseManagementEnabled?.permit_positive_or_abnormal_case_management !== 1) {
    return false;
  }

  // Check account-specific settings
  const accountSetting = await AccountSettings.getByAccountId(accountId);
  logger.info(`Account setting retrieved: ${JSON.stringify(accountSetting)}`);
  // Return true if account-level case management is enabled, false otherwise
  return accountSetting?.enable_positive_abnormal_case_management === 1 || false;
}

/**
 * Creates a new case in the case management system.
 * @param data - The data required to create the case.
 * @returns A promise resolving to an object containing the case ID and case manager ID.
 */
async function createNewCase(data: any): Promise<{ caseId: string | number; caseManagerId: number }> {
  logger.info('Creating new case for test result');
  try {
    const caseManagerId = await CaseManagerLinker.assignCaseManager();
    logger.info(`Assigned case manager ID: ${caseManagerId}`);

    const newCaseData = {
      patient_user_id: Number(data.user_id),
      test_result_id: Number(data.test_result_id),
      create_date: toMySQLTimestamp(new Date().toISOString()),
      case_status_id: 1,
      new_positive_or_abnormal_results: 1,
      view_on_tasks: 1,
      notes: data.notes || null,
    };

    const insertResult = await Cases.create(newCaseData);
    logger.info(`Case inserted: ${JSON.stringify(insertResult)}`);
    if (!insertResult || typeof insertResult !== 'object' || !('insertId' in insertResult)) {
      throw new Error('No ID returned from case creation');
    }

    // Link the case manager to the new case
    const caseLinker = await linkCaseManager(insertResult['insertId'], caseManagerId);
    logger.info(`Case manager linked: ${JSON.stringify(caseLinker)}`);

    // Link product and bundle for the case
    const productAndBundleData = {
      case_id: insertResult['insertId'],
      product_id: data.product_id || null,
      bundle_id: data.bundle_id || null,
      test_result_id: data.test_result_id || null,
      order_id: data.order_id || null,
    };
    const productAndBundleResult = await CaseManagementProductsAndBundles.create(productAndBundleData);
    logger.info(`Linked product and bundle: ${JSON.stringify(productAndBundleResult)}`);

    const responseTypeResult = await CaseManagementProductsAndBundles.updateResponseType(data.account_id, data.product_id);
    logger.info(`Updated response type: ${JSON.stringify(responseTypeResult)}`);

    return { caseId: insertResult['insertId'], caseManagerId };
  } catch (error) {
    logger.error('Error creating new case', { error });
    if (error instanceof Error) {
      throw new Error(`Failed to create new case: ${error.message}`);
    } else {
      throw new Error('Failed to create new case: Unknown error');
    }
  }
}

/**
 * Links a case manager to a case.
 * @param caseId - The ID of the case.
 * @param caseManagerId - The ID of the case manager.
 * @returns A promise that resolves when the link is created.
 */
async function linkCaseManager(caseId: number | string, caseManagerId: number | string): Promise<void> {
  logger.info(`Linking case manager to case: ${caseId} with case manager ID: ${caseManagerId}`);
  const linkerData = {
    case_id: caseId,
    user_id: caseManagerId,
    assigned_date: new Date().toISOString().slice(0, 19).replace('T', ' '),
    active: 1,
    reassigned_to_case_manager_linker_id: null,
  };
  const linkerResult = await CaseManagerLinker.create(linkerData);
  logger.info(`CaseManagerLinker created: ${JSON.stringify(linkerResult)}`);
}

/**
 * Updates an existing case with new product and bundle data.
 * @param data - The data required to update the case.
 * @returns A promise that resolves when the update is complete.
 */
async function updateExistingCase(data: any): Promise<void> {
  try {
    logger.info('Updating existing case');
    const patientId = data.user_id;
    const caseId = await Cases.fetchCaseIdByPatientQuery(patientId);
    logger.info(`Fetched case ID: ${caseId}`);

    const productAndBundleData = {
      case_id: caseId,
      product_id: data.product_id || null,
      bundle_id: data.bundle_id || null,
      test_result_id: data.test_result_id || null,
      order_id: data.order_id || null,
    };
    const productAndBundleResult = await CaseManagementProductsAndBundles.create(productAndBundleData);
    logger.info(`Linked product and bundle: ${JSON.stringify(productAndBundleResult)}`);

    await CaseManagementProductsAndBundles.updateResponseType(data.account_id, data.product_id);
    logger.info(`Updated responseType for productID ${data.product_id} with accountID ${data.account_id}`);

    await Cases.updatePositiveFlagQuery(caseId);
    logger.info(`Updated NewPositiveOrAbnormalResults to 1 for caseID ${caseId}`);
  } catch (error) {
    logger.error('Error in CaseManagement.updateExistingCase', { error });
    throw error;
  }
}
