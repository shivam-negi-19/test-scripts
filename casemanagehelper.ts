/* eslint-disable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-unused-vars */

import { TestResult, Case, CaseManagementProductAndBundleModel, CaseManagerLinker, CaseManager } from '../model/testCaseManagement';
import { TestResult as TestResultType, Case as CaseType } from '../types/testCaseManagement';
import { testResultSchema, caseSchema, caseManagementProductAndBundleSchema, caseManagerLinkerSchema, getResponseType, isInCaseManagementScope, LAB_NAMES } from '../validations/testCaseManagement';
import { DB } from '../config/db';
import crypto from 'crypto';

/**
 * Helper function to format ISO date to MySQL TIMESTAMP
 */
function toMySQLTimestamp(isoDate: string): string {
  return new Date(isoDate).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Determines if a test result is positive or abnormal
 */
export const isPositiveOrAbnormal = (labName: string, result: unknown): boolean => {
  if (!result || typeof result !== 'object') return false;
  const obj = result as Record<string, unknown>;
  
  switch (labName) {
    case LAB_NAMES.CRELIO:
      return analyzeCrelio(obj);
    case LAB_NAMES.SPOTDX:
      return analyzeSpotDx(obj);
    default:
      return false;
  }
};


function analyzeCrelio(result: Record<string, unknown> = {}): boolean {
  const reportFormat = (result.reportFormat as Record<string, unknown>) || {};
  console.log("reportFormat", result);

  if (typeof reportFormat.highlightFlag === 'number') return reportFormat.highlightFlag === 1;

  const num = parseFloat(result.value as string || '');
  if (isNaN(num)) return false;

  const gender = result.gender?.toString().toLowerCase();
  console.log("Gender base filet ",gender)
  if (gender !== 'male' && gender !== 'female') return false;

  const [lowerKey, upperKey] = gender === 'male' 
    ? ['lowerBoundMale', 'upperBoundMale'] 
    : ['lowerBoundFemale', 'upperBoundFemale'];

  const lower = parseFloat(reportFormat[lowerKey] as string || '0');
  const upper = parseFloat(reportFormat[upperKey] as string || '0');

  return !isNaN(lower) && !isNaN(upper) && (num < lower || num > upper);
}

function analyzeSpotDx(result: Record<string, unknown>): boolean {
  const resultType = result.report_type;
  const resultValue = result.result;
  console.log("resultType", resultType);
  console.log("resultValue", resultValue);
  console.log("result alll------------------------------", result);

  if (resultType === 'reactivity') {
    console.log("Inside the reactivity", resultValue);
    return String(resultValue).toLowerCase() === 'positive';
  }

  if (resultType === 'genotype') {
      console.log("Inside the genotype", resultValue);

    return false;
  }

  if (resultType === 'quantity') {
        console.log("Inside the quantity", resultValue);

    let numericValue: number;
    let isLessThan = false;
    let isGreaterThan = false;

    if (typeof resultValue === 'number') {
      console.log("Is numeric")
      numericValue = resultValue;
    } else if (typeof resultValue === 'string') {
      console.log("Is string")
      const trimmed = resultValue.trim();
      console.log("Trimmed", trimmed)
      if (trimmed.startsWith('<')) {
        numericValue = parseFloat(trimmed.slice(1));
        console.log("Less than", numericValue)
        isLessThan = true;
      } else if (trimmed.startsWith('>')) {
        numericValue = parseFloat(trimmed.slice(1));
        isGreaterThan = true;
      } else {
        console.log("Not less than or greater than")
        numericValue = parseFloat(trimmed);
      }
      if (isNaN(numericValue)) return false;
    } else {
      console.log("Last nana run")
      return false;
    }

    const rangeMin = typeof result.minimum_range === 'number' ? result.minimum_range : null;
    const rangeMax = typeof result.maximum_range === 'number' ? result.maximum_range : null;
    console.log("Range min and max", rangeMin, rangeMax)
    if (rangeMin !== null && rangeMax !== null) {
      if (isLessThan) return numericValue < rangeMin;
      if (isGreaterThan) return numericValue > rangeMax;
      return numericValue < rangeMin || numericValue > rangeMax;
    }
  }

  return false;
}
/**
 * Parses and processes SPOTDX test results
 */
function processSpotDxResults(report: any): TestResultType[] {
  const testResults: TestResultType[] = [];
  const reports = report?.reports || [];

  for (const r of reports) {
    const results = r?.report_result || [];

    for (const result of results) {
      console.log("Indiidual result,",result)
      const isPositive = isPositiveOrAbnormal(LAB_NAMES.SPOTDX, result);
      console.log("isPositive", isPositive);
      
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
      console.log("Test result", testResult);
      
      if (!testResultSchema.validate(testResult).error) {
        testResults.push(testResult);
      }
    }
  }
  return testResults;
}

/**
 * Parses and processes CRELIO test results
 */
function processCrelioResults(report: any): TestResultType[] {
  const testResults: TestResultType[] = [];
  const patientId = String(report['Patient Id'] || '');
  const accountId = '1121';
  const reportFormatAndValues = report.reportFormatAndValues || [];
  const gender = report.Gender || null;

  for (const item of reportFormatAndValues) {
    const updatedItem = { ...item, gender };
    const isPositive = isPositiveOrAbnormal(LAB_NAMES.CRELIO, updatedItem);
    
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
    }
  }
  return testResults;
}

/**
 * Handles case management logic for lab reports
 */
export async function caseManagementHandler(labName: string, report: any): Promise<void> {
  // console.log(`Processing report for lab: ${labName}`);
  let testResults: TestResultType[] = [];

  if (labName === LAB_NAMES.SPOTDX) {
    testResults = processSpotDxResults(report);
  } else if (labName === LAB_NAMES.CRELIO) {
    testResults = processCrelioResults(report);
  }


  for (const testResult of testResults) {
    // console.log("Test result to be inserted", testResult);
    await TestResult.insertOrUpdate(testResult);
    // if (!testResult.is_positive_or_abnormal) {
    //   await TestResult.updateById(testResult.id, { needsProcessing: false });
    //   continue;
    // }
    if (!(await isInCaseManagementScope(testResult.productId, testResult.accountId))) {
      await TestResult.updateById(testResult.id, { needsProcessing: false });
      continue;
    }
    if (await isTestResultProcessed(testResult.id)) {
      await TestResult.updateById(testResult.id, { needsProcessing: false });
      continue;
    }
    const existingCase = await findExistingOpenCase(testResult.patientId);
    let caseId: string;
    if (existingCase) {
      caseId = existingCase.id;
      await updateExistingCase(caseId, existingCase);
    } else {
      const { caseId: newCaseId, caseManagerId } = await createNewCase(testResult);
      caseId = newCaseId;
      await linkCaseManager(caseId, caseManagerId);
    }
    await linkTestResultToCase(caseId, testResult);
    await TestResult.updateById(testResult.id, { needsProcessing: false });
  }
}

// Remaining functions remain unchanged
async function isTestResultProcessed(testResultId: number): Promise<boolean> {
  const link = await CaseManagementProductAndBundleModel.getByTestResultId(testResultId);
  return link !== null;
}

async function findExistingOpenCase(patientId: string): Promise<CaseType | null> {
  return Case.findOpenByPatientId(patientId);
}

async function assignCaseManager(): Promise<number> {
  const managers = await CaseManager.getActive();
  if (!managers.length) throw new Error('No active case managers');
  const workloads = await Promise.all(managers.map(async (manager) => {
    const [openCases]: [Array<{ count: number }>] = await DB.query(
      'SELECT COUNT(*) as count FROM test_db_Cases WHERE caseManagerId = ? AND isClosed = 0',
      [manager.id]
    );
    return { managerId: manager.id, caseCount: openCases[0].count };
  }));
  const leastLoaded = workloads.reduce((min, current) => current.caseCount < min.caseCount ? current : min);
  return leastLoaded.managerId;
}

async function createNewCase(result: TestResultType): Promise<{ caseId: string; caseManagerId: number }> {
  const caseManagerId = await assignCaseManager();
  const newCaseData = {
    id: crypto.randomUUID(),
    patientId: result.patientId,
    caseManagerId,
    status: 'Untouched' as const,
    isClosed: false,
    visibleToProvider: false,
    visibleToMedicalStaff: false,
    visibleToCaseManager: true,
    newPositiveOrAbnormalResults: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const { error } = caseSchema.validate(newCaseData);
  if (error) throw new Error(`Case validation error: ${error.message}`);
  await Case.insertOrUpdate(newCaseData);
  return { caseId: newCaseData.id, caseManagerId };
}

async function updateExistingCase(caseId: string, existingCase: CaseType): Promise<void> {
  const updateData = { newPositiveOrAbnormalResults: true };
  const { error } = caseSchema.validate({ ...existingCase, ...updateData });
  if (error) throw new Error(`Case validation error: ${error.message}`);
  await Case.updateById(caseId, updateData);
}

async function linkTestResultToCase(caseId: string, result: TestResultType): Promise<void> {
  const responseType = await getResponseType(result.productId);
  const linkData = {
    id: 0,
    caseId,
    testResultId: result.id,
    productId: result.productId,
    bundleId: result.bundleId || null,
    responseType,
    needsProcessing: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const { error } = caseManagementProductAndBundleSchema.validate(linkData);
  if (error) throw new Error(`Link validation error: ${error.message}`);
  await CaseManagementProductAndBundleModel.insertOrUpdate(linkData);
}

async function linkCaseManager(caseId: string, caseManagerId: number): Promise<void> {
  const linkerData = {
    id: 0,
    caseId,
    caseManagerId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const { error } = caseManagerLinkerSchema.validate(linkerData);
  if (error) throw new Error(`Linker validation error: ${error.message}`);
  await CaseManagerLinker.insertOrUpdate(linkerData);
}
