/* eslint-disable @typescript-eslint/no-explicit-any */
import { DB } from '../config/db';
import BaseModel from './Base';
import { 
  TestResult as TestResultType, 
  Case as CaseType, 
  CaseManagementProductAndBundle, 
  CaseManagerLinker as CaseManagerLinkerType, 
  ProductRule as ProductRuleType,
  GlobalSetting as GlobalSettingType,
  AccountSetting as AccountSettingType,
  CaseManager as CaseManagerType,
  // Account as AccountType,
  // Product as ProductType,
  // Bundle as BundleType,
} from '../types/testCaseManagement';

export class TestResult extends BaseModel {
  protected static tableName = 'test_db_TestResults';

  static async create(data: TestResultType): Promise<any> {
    const dataWithoutId = { ...data };
    delete dataWithoutId.id;
    const columns = Object.keys(dataWithoutId).join(', ');
    const placeholders = Object.keys(dataWithoutId).map(() => '?').join(', ');
    const values = Object.values(dataWithoutId);
    const query = `INSERT INTO ${this.tableName} (${columns}) VALUES (${placeholders})`;
    try {
      const result = await DB.query(query, values);
      console.log('Raw DB.query result (create):', result);
      if (!result || (!result.insertId && (!Array.isArray(result) || !result[0]?.insertId))) {
        throw new Error('Insert failed: No insertId returned');
      }
      return result.insertId ? result : result[0];
    } catch (error) {
      console.error('Database Error in TestResult.create:', error);
      throw error;
    }
  }

  static async insertOrUpdate(data: TestResultType): Promise<any> {
    const KEYS = Object.keys(data).map(key => key).join(', ');
    const VALUES = Object.values(data).map(() => '?').join(', ');
    const UPDATES = Object.keys(data).map(col => `${col} = VALUES(${col})`).join(', ');
    const SQL = `INSERT INTO ${this.tableName} (${KEYS}) VALUES (${VALUES}) ON DUPLICATE KEY UPDATE ${UPDATES};`;
    try {
      const result = await DB.query(SQL, Object.values(data));
      return result;
    } catch (error) {
      console.error('Database Error in TestResult.insertOrUpdate:', error);
      throw error;
    }
  }

  static async getUnprocessed(): Promise<TestResultType[]> {
    const result = await DB.query(`SELECT * FROM ${this.tableName} WHERE needsProcessing = 1;`);
    const rows = Array.isArray(result) ? result : result?.rows || [];
    return rows;
  }

  static async updateById(id: number, updates: Partial<TestResultType>): Promise<any> {
    const columns = Object.keys(updates);
    const values = Object.values(updates);
    const query = `UPDATE ${this.tableName} SET ${columns.map(col => `${col} = ?`).join(', ')} WHERE id = ?;`;
    const result = await DB.query(query, [...values, id]);
    return result;
  }

  static async getById(id: number): Promise<TestResultType | null> {
    const result = await DB.query(`SELECT * FROM ${this.tableName} WHERE id = ? LIMIT 1;`, [id]);
    const rows = Array.isArray(result) ? result : result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }
}

export class Case extends BaseModel {
  protected static tableName = 'test_db_Cases';

  static async insertOrUpdate(data: CaseType): Promise<any> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const query = `INSERT INTO ${this.tableName} (${columns.join(',')}) 
                   VALUES (${values.map(() => '?').join(',')}) 
                   ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
    const result = await DB.query(query, values);
    return result;
  }

  static async findOpenByPatientIdAndTestName(patientId: string, testName: string): Promise<CaseType | null> {
    const result = await DB.query(
      `SELECT c.* FROM ${this.tableName} c WHERE c.patientId = ? AND c.testName = ? AND c.isClosed = 0 LIMIT 1;`,
      [patientId, testName]
    );
    const rows = Array.isArray(result) ? result : result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }

  static async findClosedByPatientIdAndTestName(patientId: string, testName: string): Promise<CaseType | null> {
    const result = await DB.query(
      `SELECT c.* FROM ${this.tableName} c WHERE c.patientId = ? AND c.testName = ? AND c.isClosed = 1 LIMIT 1;`,
      [patientId, testName]
    );
    const rows = Array.isArray(result) ? result : result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }

  static async updateById(id: string, updates: Partial<CaseType>): Promise<any> {
    const columns = Object.keys(updates);
    const values = Object.values(updates);
    const query = `UPDATE ${this.tableName} SET ${columns.map(col => `${col} = ?`).join(', ')} WHERE id = ?;`;
    const result = await DB.query(query, [...values, id]);
    return result;
  }


  static async getNewPositiveCases(): Promise<CaseType[]> {
    const query = `SELECT * FROM ${this.tableName} WHERE newPositiveOrAbnormalResults = 1`;
    const result = await DB.query(query);
    const rows = Array.isArray(result) ? result : result?.rows || [];
    console.log("rows", rows);
    return rows;
  }


  // Transferred from CaseNotification
  static async getCase(caseId: string): Promise<any | null> {
    const [rows] = await DB.query(
      `
      SELECT id, patientId, testName, caseManagerId, status, isClosed,
             visibleToProvider, visibleToMedicalStaff, visibleToCaseManager,
             newPositiveOrAbnormalResults, createdAt, updatedAt
      FROM ${this.tableName} 
      WHERE id = ?
      LIMIT 1
      `,
      [caseId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // Transferred from CaseNotification
 static async getCasesWithNewResults(): Promise<any[]> {
  console.log(`Querying ${this.tableName} for cases with new positive/abnormal results`);
  const rows = await DB.query(
    `
    SELECT id, patientId, testName, caseManagerId, status, isClosed,
           visibleToProvider, visibleToMedicalStaff, visibleToCaseManager,
           newPositiveOrAbnormalResults, createdAt, updatedAt
    FROM ${this.tableName}
    WHERE newPositiveOrAbnormalResults = 1
    `
  );
  console.log('Rows retrieved from DB:', rows);
  const result = Array.isArray(rows) ? rows : [];
  console.log(`Returning ${result.length} cases with new results`);
  return result;
}

  // Transferred from CaseNotification
  static async updateCaseFlag(caseId: string, value: number): Promise<void> {
    const result = await DB.query(
      `
      UPDATE ${this.tableName} 
      SET newPositiveOrAbnormalResults = ?
      WHERE id = ?
      `,
      [value, caseId]
    );
    const affectedRows = result?.affectedRows || 0;
    if (affectedRows === 0) {
      throw new Error(`Failed to update newPositiveOrAbnormalResults for case ${caseId}: No rows affected`);
    }
  }

  
}

export class CaseManagementProductAndBundleModel extends BaseModel {
  protected static tableName = 'test_db_CaseManagementProductsAndBundles';

  static async insertOrUpdate(data: CaseManagementProductAndBundle): Promise<any> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const query = `INSERT INTO ${this.tableName} (${columns.join(',')}) 
                   VALUES (${values.map(() => '?').join(',')}) 
                   ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
    const result = await DB.query(query, values);
    return result;
  }

  static async getByTestResultId(testResultId: number): Promise<CaseManagementProductAndBundle | null> {
    const result = await DB.query(`SELECT * FROM ${this.tableName} WHERE testResultId = ? LIMIT 1;`, [testResultId]);
    const rows = Array.isArray(result) ? result : result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }
}

export class CaseManagerLinker extends BaseModel {
  protected static tableName = 'test_db_CaseManagerLinker';

  static async insertOrUpdate(data: CaseManagerLinkerType): Promise<any> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const query = `INSERT INTO ${this.tableName} (${columns.join(',')}) 
                   VALUES (${values.map(() => '?').join(',')}) 
                   ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
    const result = await DB.query(query, values);
    return result;
  }
}

export class ProductRule extends BaseModel {
  protected static tableName = 'test_db_ProductRules';

  static async getByProductId(productId: number | null): Promise<ProductRuleType | null> {
    if (productId === null) return null;
    const result = await DB.query(`SELECT * FROM ${this.tableName} WHERE productId = ? LIMIT 1;`, [productId]);
    const rows = Array.isArray(result) ? result : result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }
}

export class CaseManager extends BaseModel {
  protected static tableName = 'test_db_CaseManagers';

  static async insertOrUpdate(data: CaseManagerType): Promise<any> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const query = `INSERT INTO ${this.tableName} (${columns.join(',')}) 
                   VALUES (${values.map(() => '?').join(',')}) 
                   ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
    const result = await DB.query(query, values);
    return result;
  }

  static async getActive(): Promise<CaseManagerType[]> {
    const result = await DB.query(`SELECT * FROM ${this.tableName} WHERE isActive = 1;`);
    const rows = Array.isArray(result) ? result : result?.rows || [];
    return rows;
  }

  static async getActiveCaseManagers(): Promise<CaseManagerType[]> {
    const result = await DB.query(
      `SELECT * FROM ${this.tableName} WHERE isActive = 1 AND canBeAssignedCases = 1;`
    );
    const rows = Array.isArray(result) ? result : result?.rows || [];
    return rows;
  }

  // New method to get workloads for active case managers
  static async getWorkloads(): Promise<{ managerId: number; caseCount: number }[]> {
    const managers = await this.getActiveCaseManagers();
    if (!managers.length) return [];

    const workloads = await Promise.all(
      managers.map(async (manager: CaseManagerType) => {
        const result = await DB.query(
          'SELECT COUNT(*) as count FROM test_db_Cases WHERE caseManagerId = ? AND isClosed = 0',
          [manager.id]
        );
        console.log(`Workload for manager ${manager.id}:`, result);
        const rows = Array.isArray(result) ? result : result?.rows || [];
        return { managerId: manager.id, caseCount: rows[0]?.count || 0 };
      })
    );
    return workloads;
  }

  // Transferred from CaseNotification
  static async getCaseManager(caseManagerId: number): Promise<any | null> {
    const rows = await DB.query(
      `
      SELECT id, name, isActive, createdAt, updatedAt, canBeAssignedCases
      FROM ${this.tableName} 
      WHERE id = ?
      LIMIT 1
      `,
      [caseManagerId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

}

export class GlobalSetting extends BaseModel {
  protected static tableName = 'test_db_GlobalSettings';

  static async get(): Promise<GlobalSettingType | null> {
    const result = await DB.query(`SELECT * FROM ${this.tableName} LIMIT 1;`);
    const rows = Array.isArray(result) ? result : result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }
}

export class AccountSetting extends BaseModel {
  protected static tableName = 'test_db_AccountSettings';

  static async getByAccountId(accountId: string): Promise<AccountSettingType | null> {
    const result = await DB.query(
      `SELECT * FROM ${this.tableName} WHERE accountId = ? LIMIT 1;`,
      [accountId]
    );
    const rows = Array.isArray(result) ? result : result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }
}

// export class Account extends BaseModel {
//   protected static tableName = 'test_db_Accounts';

//   static async insertOrUpdate(data: AccountType): Promise<any> {
//     const columns = Object.keys(data);
//     const values = Object.values(data);
//     const query = `INSERT INTO ${this.tableName} (${columns.join(',')}) 
//                    VALUES (${values.map(() => '?').join(',')}) 
//                    ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
//     const result = await DB.query(query, values);
//     return result;
//   }
// }

// export class Product extends BaseModel {
//   protected static tableName = 'test_db_Products';

//   static async insertOrUpdate(data: ProductType): Promise<any> {
//     const columns = Object.keys(data);
//     const values = Object.values(data);
//     const query = `INSERT INTO ${this.tableName} (${columns.join(',')}) 
//                    VALUES (${values.map(() => '?').join(',')}) 
//                    ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
//     const result = await DB.query(query, values);
//     return result;
//   }
// }

// export class Bundle extends BaseModel {
//   protected static tableName = 'test_db_Bundles';

//   static async insertOrUpdate(data: BundleType): Promise<any> {
//     const columns = Object.keys(data);
//     const values = Object.values(data);
//     const query = `INSERT INTO ${this.tableName} (${columns.join(',')}) 
//                    VALUES (${values.map(() => '?').join(',')}) 
//                    ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
//     const result = await DB.query(query, values);
//     return result;
//   }
// }


// export class CaseNotification extends BaseModel {
//   protected static tableName = 'test_db_CaseNotifications';

//   // Fetch all notifications for a case
//   static async getByCaseId(caseId: string): Promise<any[]> {
//     const result = await this.getBy('caseId', caseId);
//     const rows = Array.isArray(result) ? result : result?.rows || [];
//     return rows.sort((a: any, b: any) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
//   }

//   // Create a new notification (adjusted to match BaseModel.create)
//   static async create(data: { caseId: string; caseManagerId: number; templateID: number; reminderCount?: number }): Promise<number> {
//     const { caseId, caseManagerId, templateID, reminderCount = 0 } = data;
//     const insertData = {
//       caseId,
//       caseManagerId,
//       templateID,
//       reminderCount,
//     };
//     const result = await super.create(insertData);
//     if (!result || !result.insertId) {
//       throw new Error('Failed to create notification: No insertId returned');
//     }
//     return result.insertId;
//   }

//   // Fetch template details
//   static async getTemplate(templateID: number): Promise<any | null> {
//     const result = await DB.query(
//       `
//       SELECT templateID, messagingID, messageTypeID, templateType, subject, body,
//              delayDurationInDays, numberOfReminders, startDate, language_id,
//              message_template_grouping_id, message_template_bundle,
//              permit_pdf_download, permit_share_email, updated_at
//       FROM message_templates
//       WHERE templateID = ?
//       LIMIT 1
//       `,
//       [templateID]
//     );
//     const rows = Array.isArray(result) ? result : result?.rows || [];
//     return rows.length > 0 ? rows[0] : null;
//   }

//   // Mark a notification as clicked and update related case
//   static async markClicked(caseId: string, caseManagerId: number): Promise<void> {
//     const result = await DB.query(
//       `
//       UPDATE ${this.tableName}  n
//       JOIN test_db_Cases c ON n.caseId = c.id
//       SET n.clicked = 1,
//           c.newPositiveOrAbnormalResults = 0
//       WHERE n.caseId = ? AND n.caseManagerId = ?
//       `,
//       [caseId, caseManagerId]
//     );
//     const affectedRows = result?.affectedRows || 0;
//     if (affectedRows === 0) {
//       throw new Error('Failed to mark notification as clicked: No rows affected');
//     }
//   }

//   // Fetch case details (helper method for validation or context)
//   static async getCase(caseId: string): Promise<any | null> {
//     const result = await DB.query(
//       `
//       SELECT id, patientId, testName, caseManagerId, status, isClosed,
//              visibleToProvider, visibleToMedicalStaff, visibleToCaseManager,
//              newPositiveOrAbnormalResults, createdAt, updatedAt
//       FROM test_db_Cases
//       WHERE id = ?
//       LIMIT 1
//       `,
//       [caseId]
//     );
//     const rows = Array.isArray(result) ? result : result?.rows || [];
//     return rows.length > 0 ? rows[0] : null;
//   }

//   // Fetch case manager details (helper method for validation or context)
//   static async getCaseManager(caseManagerId: number): Promise<any | null> {
//     const result = await DB.query(
//       `
//       SELECT id, name, isActive, createdAt, updatedAt, canBeAssignedCases
//       FROM test_db_CaseManagers
//       WHERE id = ?
//       LIMIT 1
//       `,
//       [caseManagerId]
//     );
//     const rows = Array.isArray(result) ? result : result?.rows || [];
//     return rows.length > 0 ? rows[0] : null;
//   }
// }


export class CaseNotification extends BaseModel {
  protected static tableName = 'test_db_CaseNotifications';

  // Fetch all notifications for a case
 static async getByCaseId(caseId: string): Promise<any[]> {
    console.log(`Fetching notifications for caseId: ${caseId}`);
    const rows = await DB.query(
      `
      SELECT id, caseId, caseManagerId, templateID, reminderCount, sentAt, clicked
      FROM ${this.tableName}
      WHERE caseId = ?
      `,
      [caseId]
    );
    console.log('Rows retrieved from DB:', rows);

    const result = Array.isArray(rows) ? rows : [];
    console.log(`Returning ${result.length} notifications for caseId: ${caseId}`);
    
    // Sort by sentAt in descending order (newest first)
    return result.sort((a: any, b: any) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
  }

  // Create a new notification
  static async create(data: { caseId: string; caseManagerId: number; templateID: number; reminderCount?: number }): Promise<number> {
    const { caseId, caseManagerId, templateID, reminderCount = 0 } = data;
    console.log(`Creating notification for caseId: ${caseId}, caseManagerId: ${caseManagerId}, templateID: ${templateID}, reminderCount: ${reminderCount}`);

    const result = await DB.query(
      `
      INSERT INTO ${this.tableName} (caseId, caseManagerId, templateID, reminderCount)
      VALUES (?, ?, ?, ?)
      `,
      [caseId, caseManagerId, templateID, reminderCount]
    );

    console.log('Insert result from DB:', result);

    // Check if insertId exists (mysql2/promise typically returns an object with insertId)
    const insertId = result.insertId;
    if (!insertId || insertId === 0) {
      throw new Error('Failed to create notification: No insertId returned or insertId is 0');
    }

    console.log(`Notification created with insertId: ${insertId}`);
    return insertId;
  }

  // Fetch template details
  static async getTemplate(templateID: number): Promise<any | null> {
    const result = await DB.query(
      `
      SELECT templateID, messagingID, messageTypeID, templateType, subject, body,
             delayDurationInDays, numberOfReminders, startDate, language_id,
             message_template_grouping_id, message_template_bundle,
             permit_pdf_download, permit_share_email, updated_at
      FROM message_templates
      WHERE templateID = ?
      LIMIT 1
      `,
      [templateID]
    );
    const rows = Array.isArray(result) ? result : result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }

  // Mark a notification as clicked and update related case
  static async markClicked(caseId: string, caseManagerId: number): Promise<void> {
    const result = await DB.query(
      `
      UPDATE ${this.tableName}  n
      JOIN test_db_Cases c ON n.caseId = c.id
      SET n.clicked = 1,
          c.newPositiveOrAbnormalResults = 0
      WHERE n.caseId = ? AND n.caseManagerId = ?
      `,
      [caseId, caseManagerId]
    );
    const affectedRows = result?.affectedRows || 0;
    if (affectedRows === 0) {
      throw new Error('Failed to mark notification as clicked: No rows affected');
    }
  }


}
