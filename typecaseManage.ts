export type TestResult = {
  id: number;
  patientId: string; // Standalone string, no FK
  accountId: string;
  productId: number | null;
  bundleId?: number | null;
  labName: string;
  testName: string;
  result: string;
  is_positive_or_abnormal: boolean;
  needsProcessing: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Case = {
  id: string; // String ID
  patientId: string; // Standalone string, no FK
  caseManagerId?: number | null;
  status: 'Untouched' | 'InProgress' | 'Closed';
  isClosed: boolean;
  visibleToProvider: boolean;
  visibleToMedicalStaff: boolean;
  visibleToCaseManager: boolean;
  newPositiveOrAbnormalResults: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CaseManagementProductAndBundle = {
  id: number;
  caseId: string; // String ID
  testResultId: number;
  productId: number | null;
  bundleId?: number | null;
  responseType: 'Standard' | 'Special';
  needsProcessing: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CaseManagerLinker = {
  id: number;
  caseId: string; // String ID
  caseManagerId: number;
  createdAt: string;
  updatedAt: string;
};

export type ProductRule = {
  id: number;
  productId: number | null;
  abnormal_keywords: string;
  response_type: 'Standard' | 'Special';
  createdAt: string;
  updatedAt: string;
};

export interface CaseManager {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GlobalSetting = {
  id: number;
  isCaseManagementEnabled: boolean; // Boolean flag
  createdAt: string;
  updatedAt: string;
};

export type AccountSetting = {
  id: number;
  accountId: string; // String ID
  productId: number | null;
  catalogType: 'DTC' | 'Groups' | 'UI_API';
  isCaseManagementEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Account = {
  id: string; // String ID
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type Product = {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type Bundle = {
  id: number;
  bundle_name: string;
  createdAt: string;
  updatedAt: string;
};
