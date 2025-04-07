// Defines data types for case management entities
export type TestResult = {
  id?: number;
  patientId: string;
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
  id: string;
  patientId: string;
  testName: string;
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
  caseId: string;
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
  caseId: string;
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
  canBeAssignedCases: boolean; // Added for load balancing
  createdAt: string;
  updatedAt: string;
};

export type GlobalSetting = {
  id: number;
  isCaseManagementEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AccountSetting = {
  id: number;
  accountId: string;
  isCaseManagementEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

// export type Account = {
//   id: string;
//   name: string;
//   createdAt: string;
//   updatedAt: string;
// };

// export type Product = {
//   id: number;
//   name: string;
//   createdAt: string;
//   updatedAt: string;
// };

// export type Bundle = {
//   id: number;
//   bundle_name: string;
//   createdAt: string;
//   updatedAt: string;
// };




// Notification type based on test_db_CaseNotifications
export type Notification = {
  id: number;                    // int AUTO_INCREMENT
  caseId: string;                // varchar(36)
  caseManagerId: number;         // int
  templateID: number;            // int (e.g., 363 for initial, 364 for reminder)
  sentAt: Date;                  // timestamp
  reminderCount: number;         // int
  clicked: boolean;              // tinyint(1)
};
