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
  Account as AccountType,
  Product as ProductType,
  Bundle as BundleType
} from '../types/testCaseManagement';

export class TestResult extends BaseModel {
  protected static __tableName__ = 'test_db_TestResults';
static async insertOrUpdate(data: TestResultType): Promise<void> {
    const KEYS = Object.keys(data)
      .map(key => key)
      .join(', ');
    const VALUES = Object.values(data)
      .map(() => '?')
      .join(', ');
    const UPDATES = Object.keys(data)
      .map(col => `${col} = VALUES(${col})`)
      .join(', ');

    const SQL = `INSERT INTO ${this.__tableName__} (${KEYS}) VALUES (${VALUES}) ON DUPLICATE KEY UPDATE ${UPDATES};`;

    

    try {
      await DB.query(SQL, Object.values(data));
      console.log('Insert/Update completed successfully');
    } catch (error) {
      console.error('Database Error:', error);
      throw error; // Still throw the error so the caller can handle it if needed
    }
  }


  static async getUnprocessed(): Promise<TestResultType[]> {
    const [rows] = await DB.query(`SELECT * FROM ${this.__tableName__} WHERE needsProcessing = 1;`);
    return rows;
  }

  static async updateById(id: number, updates: Partial<TestResultType>): Promise<any> {
    const columns = Object.keys(updates);
    const values = Object.values(updates);
    const query = `UPDATE ${this.__tableName__} SET ${columns.map(col => `${col} = ?`).join(', ')} WHERE id = ?;`;
    return DB.query(query, [...values, id]);
  }
}

export class Case extends BaseModel {
  protected static __tableName__ = 'test_db_Cases';

  static async insertOrUpdate(data: CaseType): Promise<any> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const query = `INSERT INTO ${this.__tableName__} (${columns.join(',')}) 
                   VALUES (${values.map(() => '?').join(',')}) 
                   ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
    return DB.query(query, values);
  }

  static async findOpenByPatientId(patientId: string): Promise<CaseType | null> {
    const [rows] = await DB.query(`SELECT * FROM ${this.__tableName__} WHERE patientId = ? AND isClosed = 0 LIMIT 1;`, [patientId]);
    return rows.length > 0 ? rows[0] : null;
  }

  static async updateById(id: string, updates: Partial<CaseType>): Promise<any> {
    const columns = Object.keys(updates);
    const values = Object.values(updates);
    const query = `UPDATE ${this.__tableName__} SET ${columns.map(col => `${col} = ?`).join(', ')} WHERE id = ?;`;
    return DB.query(query, [...values, id]);
  }
}

export class CaseManagementProductAndBundleModel extends BaseModel {
  protected static __tableName__ = 'test_db_CaseManagementProductsAndBundles';

  static async insertOrUpdate(data: CaseManagementProductAndBundle): Promise<any> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const query = `INSERT INTO ${this.__tableName__} (${columns.join(',')}) 
                   VALUES (${values.map(() => '?').join(',')}) 
                   ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
    return DB.query(query, values);
  }

  static async getByTestResultId(testResultId: number): Promise<CaseManagementProductAndBundle | null> {
    const [rows] = await DB.query(`SELECT * FROM ${this.__tableName__} WHERE testResultId = ? LIMIT 1;`, [testResultId]);
    return rows.length > 0 ? rows[0] : null;
  }
}

export class CaseManagerLinker extends BaseModel {
  protected static __tableName__ = 'test_db_CaseManagerLinker';

  static async insertOrUpdate(data: CaseManagerLinkerType): Promise<any> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const query = `INSERT INTO ${this.__tableName__} (${columns.join(',')}) 
                   VALUES (${values.map(() => '?').join(',')}) 
                   ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
    return DB.query(query, values);
  }
}

export class ProductRule extends BaseModel {
  protected static __tableName__ = 'test_db_ProductRules';

  static async getByProductId(productId: number | null): Promise<ProductRuleType | null> {
    if (productId === null) return null;
    const [rows] = await DB.query(`SELECT * FROM ${this.__tableName__} WHERE productId = ? LIMIT 1;`, [productId]);
    return rows.length > 0 ? rows[0] : null;
  }
}

export class CaseManager extends BaseModel {
  protected static __tableName__ = 'test_db_CaseManagers';

  static async insertOrUpdate(data: CaseManagerType): Promise<any> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const query = `INSERT INTO ${this.__tableName__} (${columns.join(',')}) 
                   VALUES (${values.map(() => '?').join(',')}) 
                   ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
    return DB.query(query, values);
  }

  static async getActive(): Promise<CaseManagerType[]> {
    const [rows] = await DB.query(`SELECT * FROM ${this.__tableName__} WHERE isActive = 1;`);
    return rows;
  }
}

export class GlobalSetting extends BaseModel {
  protected static __tableName__ = 'test_db_GlobalSettings';

  static async get(): Promise<GlobalSettingType | null> {
    const [rows] = await DB.query(`SELECT * FROM ${this.__tableName__} LIMIT 1;`);
    return rows.length > 0 ? rows[0] : null;
  }
}

export class AccountSetting extends BaseModel {
  protected static __tableName__ = 'test_db_AccountSettings';

  static async getByAccountAndProduct(accountId: string, productId: number | null): Promise<AccountSettingType | null> {
    if (productId === null) return null;
    const [rows] = await DB.query(
      `SELECT * FROM ${this.__tableName__} WHERE accountId = ? AND productId = ? LIMIT 1;`,
      [accountId, productId]
    );
    return rows.length > 0 ? rows[0] : null;
  }
}

export class Account extends BaseModel {
  protected static __tableName__ = 'test_db_Accounts';

  static async insertOrUpdate(data: AccountType): Promise<any> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const query = `INSERT INTO ${this.__tableName__} (${columns.join(',')}) 
                   VALUES (${values.map(() => '?').join(',')}) 
                   ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
    return DB.query(query, values);
  }
}

export class Product extends BaseModel {
  protected static __tableName__ = 'test_db_Products';

  static async insertOrUpdate(data: ProductType): Promise<any> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const query = `INSERT INTO ${this.__tableName__} (${columns.join(',')}) 
                   VALUES (${values.map(() => '?').join(',')}) 
                   ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
    return DB.query(query, values);
  }
}

export class Bundle extends BaseModel {
  protected static __tableName__ = 'test_db_Bundles';

  static async insertOrUpdate(data: BundleType): Promise<any> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const query = `INSERT INTO ${this.__tableName__} (${columns.join(',')}) 
                   VALUES (${values.map(() => '?').join(',')}) 
                   ON DUPLICATE KEY UPDATE ${columns.map(col => `${col} = VALUES(${col})`).join(', ')};`;
    return DB.query(query, values);
  }
}
