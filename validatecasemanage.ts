import Joi from 'joi';
import { ProductRule as ProductRuleModel, GlobalSetting as GlobalSettingModel, AccountSetting as AccountSettingModel } from '../model/testCaseManagement';

export const LAB_NAMES = {
  SPOTDX: 'SpotDx',
  CRELIO: 'Crelio',
} as const;

export const testResultSchema = Joi.object({
  id: Joi.number().required(),
  patientId: Joi.string().required(), // Standalone string
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

export const caseSchema = Joi.object({
  id: Joi.string().required(), // String ID
  patientId: Joi.string().required(), // Standalone string
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

export const caseManagementProductAndBundleSchema = Joi.object({
  id: Joi.number().optional(),
  caseId: Joi.string().required(), // String ID
  testResultId: Joi.number().required(),
  productId: Joi.number().allow(null),
  bundleId: Joi.number().allow(null),
  responseType: Joi.string().valid('Standard', 'Special').required(),
  needsProcessing: Joi.boolean().default(true),
  createdAt: Joi.string().isoDate().optional(),
  updatedAt: Joi.string().isoDate().optional(),
});

export const caseManagerLinkerSchema = Joi.object({
  id: Joi.number().optional(),
  caseId: Joi.string().required(), // String ID
  caseManagerId: Joi.number().required(),
  createdAt: Joi.string().isoDate().optional(),
  updatedAt: Joi.string().isoDate().optional(),
});

export async function getResponseType(productId: number | null): Promise<'Standard' | 'Special'> {
  const rule = await ProductRuleModel.getByProductId(productId);
  return rule?.response_type || 'Standard';
}

export async function isInCaseManagementScope(productId: number | null, accountId: string): Promise<boolean> {
  const globalSetting = await GlobalSettingModel.get();
  if (!globalSetting || !globalSetting.isCaseManagementEnabled) return false;

  const accountSetting = await AccountSettingModel.getByAccountAndProduct(accountId, productId);
  return accountSetting?.isCaseManagementEnabled || false;
}
