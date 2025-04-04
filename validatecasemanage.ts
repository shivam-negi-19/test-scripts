import Joi from 'joi';
import { ProductRule as ProductRuleModel, GlobalSetting as GlobalSettingModel, AccountSetting as AccountSettingModel } from '../model/testCaseManagement';

// Lab name constants
export const LAB_NAMES = {
  SPOTDX: 'SpotDx',
  CRELIO: 'Crelio',
} as const;

// Validation schema for TestResult
export const testResultSchema = Joi.object({
  id: Joi.number().optional(),
  patientId: Joi.string().required(),
  accountId: Joi.string().required(),
  productId: Joi.number().allow(null),
  bundleId: Joi.number().allow(null),
  labName: Joi.string().required(),
  testName: Joi.string().required(),
  result: Joi.string().required(),
  is_positive_or_abnormal: Joi.boolean().required(),
  needsProcessing: Joi.boolean().required(),
  createdAt: Joi.string().isoDate().required(),
  updatedAt: Joi.string().isoDate().required(),
});

// Validation schema for Case (updated with testName)
export const caseSchema = Joi.object({
  id: Joi.string().required(),
  patientId: Joi.string().required(),
  testName: Joi.string().required(), // Added for case-specific test name
  caseManagerId: Joi.number().allow(null),
  status: Joi.string().valid('Untouched', 'InProgress', 'Closed').default('Untouched'),
  isClosed: Joi.boolean().default(false),
  visibleToProvider: Joi.boolean().default(false),
  visibleToMedicalStaff: Joi.boolean().default(false),
  visibleToCaseManager: Joi.boolean().default(true),
  newPositiveOrAbnormalResults: Joi.boolean().default(false),
  createdAt: Joi.string().isoDate().optional(),
  updatedAt: Joi.string().isoDate().optional(),
});

// Validation schema for CaseManagementProductAndBundle
export const caseManagementProductAndBundleSchema = Joi.object({
  id: Joi.number().optional(),
  caseId: Joi.string().required(),
  testResultId: Joi.number().required(),
  productId: Joi.number().allow(null),
  bundleId: Joi.number().allow(null),
  responseType: Joi.string().valid('Standard', 'Special').required(),
  needsProcessing: Joi.boolean().default(true),
  createdAt: Joi.string().isoDate().optional(),
  updatedAt: Joi.string().isoDate().optional(),
});

// Validation schema for CaseManagerLinker
export const caseManagerLinkerSchema = Joi.object({
  id: Joi.number().optional(),
  caseId: Joi.string().required(),
  caseManagerId: Joi.number().required(),
  createdAt: Joi.string().isoDate().optional(),
  updatedAt: Joi.string().isoDate().optional(),
});

/** Determines the response type based on product rules.
@param productId Product ID or null
@returns Response type ('Standard' or 'Special')
*/
export async function getResponseType(productId: number | null): Promise<'Standard' | 'Special'> {
  if (productId === null) return 'Standard';
  const rule = await ProductRuleModel.getByProductId(productId);
  return rule?.response_type || 'Standard';
}

/** Checks if case management is enabled for an account.
@param productId Product ID (not used currently)
@param accountId Account ID
@returns Boolean indicating if case management is in scope
*/
export async function isInCaseManagementScope(productId: number | null, accountId: string): Promise<boolean> {
  const globalSetting = await GlobalSettingModel.get();
  if (!globalSetting || !globalSetting.isCaseManagementEnabled) return false;
  const accountSetting = await AccountSettingModel.getByAccountId(accountId);
  return accountSetting?.isCaseManagementEnabled || false;
}
