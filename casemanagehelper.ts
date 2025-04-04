/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { TestResult, Case, CaseManagementProductAndBundleModel, CaseManagerLinker, CaseManager } from '../model/testCaseManagement';
import { TestResult as TestResultType, Case as CaseType } from '../types/testCaseManagement';
import { testResultSchema, caseSchema, caseManagementProductAndBundleSchema, caseManagerLinkerSchema, getResponseType, isInCaseManagementScope, LAB_NAMES } from '../validations/testCaseManagement';
import { DB } from '../config/db';
import crypto from 'crypto';

// -----------------------------------
// UTILITY FUNCTIONS
// -----------------------------------
/** Converts ISO date string to MySQL-compatible timestamp format (YYYY-MM-DD HH:MM:SS).
@param isoDate ISO date string (e.g., '2025-04-04T08:12:59.081Z')
@returns MySQL timestamp string (e.g., '2025-04-04 08:12:59')
*/
function toMySQLTimestamp(isoDate: string): string {
  return new Date(isoDate).toISOString().slice(0, 19).replace('T', ' ');
}

// -----------------------------------
// RESULT ANALYSIS FUNCTIONS
// -----------------------------------
/** Determines if a test result is positive or abnormal based on lab-specific logic.
@param labName Name of the lab (SpotDx or Crelio)
@param result Test result data
@returns Boolean indicating if the result is positive or abnormal
*/
export const isPositiveOrAbnormal = (labName: string, result: unknown): boolean => {
  console.log(`Analyzing result for lab: ${labName}`);
  if (!result || typeof result !== 'object') {
    console.log('Result is invalid or not an object, returning false');
    return false;
  }
  const obj = result as Record<string, unknown>;
  switch (labName) {
    case LAB_NAMES.CRELIO:
      return analyzeCrelio(obj);
    case LAB_NAMES.SPOTDX:
      return analyzeSpotDx(obj);
    default:
      console.log(`Unknown lab: ${labName}, returning false`);
      return false;
  }
};

/** Analyzes Crelio test results for positive or abnormal conditions.
@param result Crelio result object
@returns Boolean indicating if the result is abnormal
*/
function analyzeCrelio(result: Record<string, unknown> = {}): boolean {
  const reportFormat = (result.reportFormat as Record<string, unknown>) || {};
  console.log('Crelio reportFormat:', result);
  if (typeof reportFormat.highlightFlag === 'number') {
    console.log(`Highlight flag: ${reportFormat.highlightFlag}`);
    return reportFormat.highlightFlag === 1;
  }
  const num = parseFloat(result.value as string || '');
  if (isNaN(num)) {
    console.log('Value is not a number, returning false');
    return false;
  }
  const gender = result.gender?.toString().toLowerCase();
  console.log('Gender:', gender);
  if (gender !== 'male' && gender !== 'female') {
    console.log('Invalid gender, returning false');
    return false;
  }
  const [lowerKey, upperKey] = gender === 'male' 
    ? ['lowerBoundMale', 'upperBoundMale'] 
    : ['lowerBoundFemale', 'upperBoundFemale'];
  const lower = parseFloat(reportFormat[lowerKey] as string || '0');
  const upper = parseFloat(reportFormat[upperKey] as string || '0');
  console.log(`Range: ${lower} - ${upper}, Value: ${num}`);
  return !isNaN(lower) && !isNaN(upper) && (num < lower || num > upper);
}

/** Analyzes SpotDx test results for positive or abnormal conditions.
@param result SpotDx result object
@returns Boolean indicating if the result is positive or abnormal
*/
function analyzeSpotDx(result: Record<string, unknown>): boolean {
  const resultType = result.report_type;
  const resultValue = result.result;
  console.log(`SpotDx - Result Type: ${resultType}, Value: ${resultValue}`);
  if (resultType === 'reactivity') {
    console.log('Reactivity check:', resultValue);
    return String(resultValue).toLowerCase() === 'positive';
  }
  if (resultType === 'genotype') {
    console.log('Genotype check, always false');
    return false;
  }
  if (resultType === 'quantity') {
    let numericValue: number;
    let isLessThan = false;
    let isGreaterThan = false;
    if (typeof resultValue === 'number') {
      console.log('Numeric value:', resultValue);
      numericValue = resultValue;
    } else if (typeof resultValue === 'string') {
      const trimmed = resultValue.trim();
      console.log('String value trimmed:', trimmed);
      if (trimmed.startsWith('<')) {
        numericValue = parseFloat(trimmed.slice(1));
        isLessThan = true;
        console.log('Less than:', numericValue);
      } else if (trimmed.startsWith('>')) {
        numericValue = parseFloat(trimmed.slice(1));
        isGreaterThan = true;
        console.log('Greater than:', numericValue);
      } else {
        numericValue = parseFloat(trimmed);
        console.log('Parsed value:', numericValue);
      }
      if (isNaN(numericValue)) {
        console.log('Value is NaN, returning false');
        return false;
      }
    } else {
      console.log('Invalid value type, returning false');
      return false;
    }
    const rangeMin = isNaN(Number(result.minimum_range)) ? null : Number(result.minimum_range);
    const rangeMax = isNaN(Number(result.maximum_range)) ? null : Number(result.maximum_range);
    console.log(`Range: ${rangeMin} - ${rangeMax}`);
    if (rangeMin !== null && rangeMax !== null) {
      if (isLessThan) return numericValue < rangeMin;
      if (isGreaterThan) return numericValue > rangeMax;
      return numericValue < rangeMin || numericValue > rangeMax;
    }
  }
  console.log('No conditions met, returning false');
  return false;
}

// -----------------------------------
// RESULT PROCESSING FUNCTIONS
// -----------------------------------
/** Parses and processes SpotDx test results from a report.
@param report SpotDx report data
@returns Array of processed TestResultType objects
*/
function processSpotDxResults(report: any): TestResultType[] {
  console.log('Processing SpotDx report:', report);
  const testResults: TestResultType[] = [];
  const reports = report?.reports || [];
  for (const r of reports) {
    const results = r?.report_result || [];
    console.log('Processing report ID:', r.report_id);
    for (const result of results) {
      console.log('Individual result:', result);
      const isPositive = isPositiveOrAbnormal(LAB_NAMES.SPOTDX, result);
      console.log('Is positive/abnormal:', isPositive);
      const testResult: TestResultType = {
        id: 0,
        patientId: String(r.report_id || '1231'),
        accountId: '211',
        productId: null,
        bundleId: report.bundle_sku,
        labName: LAB_NAMES.SPOTDX,
        testName: result.report_name as string,
        result: String(result.result),
        is_positive_or_abnormal: isPositive,
        needsProcessing: isPositive,
        createdAt: toMySQLTimestamp(new Date().toISOString()),
        updatedAt: toMySQLTimestamp(new Date().toISOString()),
      };
      console.log('Generated test result:', testResult);
      if (!testResultSchema.validate(testResult).error) {
        testResults.push(testResult);
      } else {
        console.log('Validation failed for test result:', testResult);
      }
    }
  }
  console.log('Processed SpotDx results:', testResults);
  return testResults;
}

/** Parses and processes Crelio test results from a report.
@param report Crelio report data
@returns Array of processed TestResultType objects
*/
function processCrelioResults(report: any): TestResultType[] {
  console.log('Processing Crelio report:', report);
  const testResults: TestResultType[] = [];
  const patientId = String(report['Patient Id'] || '');
  const accountId = '1121';
  const reportFormatAndValues = report.reportFormatAndValues || [];
  const gender = report.Gender || null;
  for (const item of reportFormatAndValues) {
    const updatedItem = { ...item, gender };
    console.log('Processing Crelio item:', updatedItem);
    const isPositive = isPositiveOrAbnormal(LAB_NAMES.CRELIO, updatedItem);
    console.log('Is positive/abnormal:', isPositive);
    const testResult: TestResultType = {
      id: 0,
      patientId,
      accountId,
      productId: null,
      bundleId: null,
      labName: LAB_NAMES.CRELIO,
      testName: item.reportFormat.testName as string,
      result: String(item.value),
      is_positive_or_abnormal: isPositive,
      needsProcessing: isPositive,
      createdAt: toMySQLTimestamp(new Date().toISOString()),
      updatedAt: toMySQLTimestamp(new Date().toISOString()),
    };
    if (!testResultSchema.validate(testResult).error) {
      testResults.push(testResult);
    } else {
      console.log('Validation failed for test result:', testResult);
    }
  }
  console.log('Processed Crelio results:', testResults);
  return testResults;
}

// -----------------------------------
// CASE MANAGEMENT HANDLER
// -----------------------------------
/** Main handler for processing test results and managing cases.
@param labName Name of the lab (SpotDx or Crelio)
@param report Raw report data
*/
export async function caseManagementHandler(labName: string, report: any): Promise<void> {
  console.log('Starting case management handler for lab:', labName);
  let testResults: TestResultType[] = [];
  // Step 1: Process report based on lab type
  if (labName === LAB_NAMES.SPOTDX) {
    testResults = processSpotDxResults(report);
  } else if (labName === LAB_NAMES.CRELIO) {
    testResults = processCrelioResults(report);
  } else {
    console.log(`Unsupported lab: ${labName}, exiting handler`);
    return;
  }
  console.log('Total test results to process:', testResults.length);
  if (testResults.length === 0) {
    console.log('No test results to process, exiting');
    return;
  }
  // Step 2: Process each test result
  for (const testResult of testResults) {
    try {
      console.log('--- Processing test result ---', testResult);
      // Insert test result into database
      console.log('Inserting test result into test_db_TestResults');
      const result = await TestResult.create(testResult);
      if (!result || typeof result.insertId !== 'number') {
        throw new Error('Failed to get insertId from TestResult.create');
      }
      testResult.id = result.insertId;
      if (!testResult.id) throw new Error('Unexpected: testResult.id is not set after insert');
      console.log('Inserted test result with ID:', testResult.id);
      // Step 3: Check if case management is applicable
      if (!testResult.is_positive_or_abnormal || !testResult.needsProcessing) {
        console.log('Skipping: Not positive/abnormal or no processing needed');
        continue;
      }
      console.log('Checking case management scope for accountId:', testResult.accountId);
      const inScope = await isInCaseManagementScope(null, testResult.accountId);
      console.log('In case management scope:', inScope);
      if (!inScope) {
        console.log('Skipping: Not in case management scope');
        continue;
      }
      // Step 4: Check if test result is already processed
      console.log('Checking if test result is already processed');
      const isProcessed = await isTestResultProcessed(testResult.id);
      console.log('Is test result processed:', isProcessed);
      if (isProcessed) {
        console.log('Skipping: Test result already processed');
        continue;
      }
      // Step 5: Manage case creation or update
      console.log('Checking for existing open case');
      const existingOpenCase = await Case.findOpenByPatientIdAndTestName(testResult.patientId, testResult.testName);
      console.log('Existing open case:', existingOpenCase);
      let caseId: string;
      if (existingOpenCase) {
        caseId = existingOpenCase.id;
        console.log('Updating existing open case:', caseId);
        await updateExistingCase(caseId, existingOpenCase);
        console.log('Updated existing open case:', caseId);
      } else {
        console.log('Checking for existing closed case');
        const existingClosedCase = await Case.findClosedByPatientIdAndTestName(testResult.patientId, testResult.testName);
        console.log('Existing closed case:', existingClosedCase);
        console.log('Creating new case');
        const { caseId: newCaseId, caseManagerId } = await createNewCase(testResult);
        caseId = newCaseId;
        console.log('Linking case manager to new case');
        await linkCaseManager(caseId, caseManagerId);
        console.log('Created new case:', caseId, 'with caseManagerId:', caseManagerId);
      }
      // Step 6: Link test result to case
      console.log('Linking test result to case:', caseId);
      await linkTestResultToCase(caseId, testResult);
      console.log('Linked test result to case:', caseId);
      // Step 7: Update test result status
      console.log('Updating test result flags');
      await TestResult.updateById(testResult.id, { needsProcessing: false });
      console.log('Updated test result flags for ID:', testResult.id);
    } catch (error) {
      console.error('Error processing test result:', testResult, 'Error:', error);
    }
  }
  console.log('Finished processing all test results');
}

// -----------------------------------
// CASE MANAGEMENT SUPPORT FUNCTIONS
// -----------------------------------
/** Checks if a test result has already been linked to a case.
@param testResultId ID of the test result
@returns Boolean indicating if the test result is processed
*/
async function isTestResultProcessed(testResultId: number): Promise<boolean> {
  console.log('Checking if test result is processed, ID:', testResultId);
  const link = await CaseManagementProductAndBundleModel.getByTestResultId(testResultId);
  console.log('Link found:', link);
  return link !== null;
}

/** Assigns a case manager based on workload (least open cases).
@returns ID of the assigned case manager
*/
async function assignCaseManager(): Promise<number> {
  console.log('Assigning case manager');
  // Get workloads for active case managers who can be assigned cases
  const workloads = await CaseManager.getWorkloads();
  console.log('Workloads:', workloads);
  
  if (!workloads.length) {
    console.log('No active case managers available');
    throw new Error('No active case managers available');
  }

  // Find the minimum case count
  const minCaseCount = Math.min(...workloads.map(w => w.caseCount));
  console.log('Minimum case count:', minCaseCount);

  // Filter managers with the minimum case count
  const leastLoadedManagers = workloads.filter(w => w.caseCount === minCaseCount);
  console.log('Least loaded managers:', leastLoadedManagers);

  // Randomly select one from the least loaded managers
  const selectedManager = leastLoadedManagers[Math.floor(Math.random() * leastLoadedManagers.length)];
  console.log('Selected case manager:', selectedManager.managerId);

  return selectedManager.managerId;
}



/** Creates a new case for a test result.
@param result Test result data
@returns Object containing case ID and case manager ID
*/
async function createNewCase(result: TestResultType): Promise<{ caseId: string; caseManagerId: number }> {
  console.log('Creating new case for test result:', result);
  const caseManagerId = await assignCaseManager();
  const newCaseData = {
    id: crypto.randomUUID(),
    patientId: result.patientId,
    testName: result.testName,
    caseManagerId,
    status: 'Untouched' as const,
    isClosed: false,
    visibleToProvider: false,
    visibleToMedicalStaff: false,
    visibleToCaseManager: true,
    newPositiveOrAbnormalResults: result.is_positive_or_abnormal,
    createdAt: toMySQLTimestamp(new Date().toISOString()),
    updatedAt: toMySQLTimestamp(new Date().toISOString()),
  };
  console.log('New case data:', newCaseData);
  const { error } = caseSchema.validate(newCaseData);
  if (error) throw new Error(`Case validation error: ${error.message}`);
  const insertResult = await Case.insertOrUpdate(newCaseData);
  console.log('Case insert result:', insertResult);
  return { caseId: newCaseData.id, caseManagerId };
}

/** Updates an existing case with new positive/abnormal results.
@param caseId ID of the case to update
@param existingCase Existing case data
*/
async function updateExistingCase(caseId: string, existingCase: CaseType): Promise<void> {
  console.log('Updating existing case:', caseId);
  const updateData = { 
    newPositiveOrAbnormalResults: true, 
    updatedAt: toMySQLTimestamp(new Date().toISOString())
  };
  const updatedCase = { ...existingCase, ...updateData };
  console.log('Updated case data:', updatedCase);
  const { error } = caseSchema.validate(updatedCase);
  if (error) throw new Error(`Case validation error: ${error.message}`);
  const updateResult = await Case.updateById(caseId, updateData);
  console.log('Case update result:', updateResult);
}

/** Links a test result to a case.
@param caseId ID of the case
@param result Test result data
*/
async function linkTestResultToCase(caseId: string, result: TestResultType): Promise<void> {
  console.log('Linking test result to case:', caseId);
  const responseType = await getResponseType(result.productId);
  const linkData = {
    id: 0,
    caseId,
    testResultId: result.id!,
    productId: result.productId,
    bundleId: result.bundleId || null,
    responseType,
    needsProcessing: true,
    createdAt: toMySQLTimestamp(new Date().toISOString()),
    updatedAt: toMySQLTimestamp(new Date().toISOString()),
  };
  console.log('Link data:', linkData);
  const { error } = caseManagementProductAndBundleSchema.validate(linkData);
  if (error) throw new Error(`Link validation error: ${error.message}`);
  const linkResult = await CaseManagementProductAndBundleModel.insertOrUpdate(linkData);
  console.log('Link result:', linkResult);
}

/** Links a case manager to a case.
@param caseId ID of the case
@param caseManagerId ID of the case manager
*/
async function linkCaseManager(caseId: string, caseManagerId: number): Promise<void> {
  console.log('Linking case manager to case:', caseId);
  const linkerData = {
    id: 0,
    caseId,
    caseManagerId,
    createdAt: toMySQLTimestamp(new Date().toISOString()),
    updatedAt: toMySQLTimestamp(new Date().toISOString()),
  };
  console.log('Linker data:', linkerData);
  const { error } = caseManagerLinkerSchema.validate(linkerData);
  if (error) throw new Error(`Linker validation error: ${error.message}`);
  const linkerResult = await CaseManagerLinker.insertOrUpdate(linkerData);
  console.log('CaseManagerLinker result:', linkerResult);
}
