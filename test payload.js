spot:
{
  "order_id": "ORD123456",
  "assignee_id": 1,
  "bundle_sku": "HLTB01",
  "specimen": {
    "specimen_id": "SPEC789",
    "specimen_status": "processed",
    "status_history": [
      {
        "status": "collected",
        "created": "2025-04-01 00:00:00"
      }
    ],
    "reports": [
      {
        "report_id": "RPT001",
        "collection_date_time": "2025-04-01 00:00:00",
        "received_date_time": "2025-04-02 00:00:00",
        "resulted_date_time": "2025-04-05 00:00:00",
        "is_revision": "no",
        "report_pdf": "http://example.com/report1.pdf",
        "report_txt": "http://example.com/report1.txt",
        "report_result": [
          {
            "report_type": "quantity",
            "report_name": "LDL Cholesterol",
            "collection_date": "2025-04-01 00:00:00",
            "measurement_units": "mg/dL",
            "minimum_range": "50",
            "maximum_range": "130",
            "notes": "Fasting sample",
            "result": ">140"
          },
          {
            "report_type": "quantity",
            "report_name": "Glucose",
            "collection_date": "2025-04-01 00:00:00",
            "measurement_units": "mg/dL",
            "minimum_range": "70",
            "maximum_range": "99",
            "notes": null,
            "result": "82"
          },
          {
            "report_type": "reactivity",
            "report_name": "HIV Antibody",
            "collection_date": "2025-04-01 00:00:00",
            "measurement_units": null,
            "minimum_range": null,
            "maximum_range": null,
            "notes": "Screening test",
            "result": "negative"
          }
        ]
      },
      {
        "report_id": "RPT002",
        "collection_date_time": "2025-04-02 00:00:00",
        "received_date_time": "2025-04-03 00:00:00",
        "resulted_date_time": "2025-04-06 00:00:00",
        "is_revision": "no",
        "report_pdf": "http://example.com/report2.pdf",
        "report_txt": "http://example.com/report2.txt",
        "report_result": [
          {
            "report_type": "quantity",
            "report_name": "Triglycerides",
            "collection_date": "2025-04-02 00:00:00",
            "measurement_units": "mg/dL",
            "minimum_range": "50",
            "maximum_range": "150",
            "notes": null,
            "result": "160"
          },
          {
            "report_type": "reactivity",
            "report_name": "Hepatitis C",
            "collection_date": "2025-04-02 00:00:00",
            "measurement_units": null,
            "minimum_range": null,
            "maximum_range": null,
            "notes": null,
            "result": "positive"
          },
          {
            "report_type": "genotype",
            "report_name": "rs1801133",
            "collection_date": "2025-04-02 00:00:00",
            "measurement_units": null,
            "minimum_range": null,
            "maximum_range": null,
            "notes": "MTHFR gene variant",
            "result": "CT"
          }
        ]
      },
      {
        "report_id": "RPT003",
        "collection_date_time": "2025-04-03 00:00:00",
        "received_date_time": "2025-04-04 00:00:00",
        "resulted_date_time": "2025-04-07 00:00:00",
        "is_revision": "no",
        "report_pdf": "http://example.com/report3.pdf",
        "report_txt": "http://example.com/report3.txt",
        "report_result": [
          {
            "report_type": "quantity",
            "report_name": "Vitamin D",
            "collection_date": "2025-04-03 00:00:00",
            "measurement_units": "ng/mL",
            "minimum_range": "20",
            "maximum_range": "50",
            "notes": "Deficiency indicated",
            "result": "<20"
          },
          {
            "report_type": "genotype",
            "report_name": "rs9939609",
            "collection_date": "2025-04-03 00:00:00",
            "measurement_units": null,
            "minimum_range": null,
            "maximum_range": null,
            "notes": "FTO gene variant",
            "result": "AA"
          },
          {
            "report_type": "genotype",
            "report_name": "rs662799",
            "collection_date": "2025-04-03 00:00:00",
            "measurement_units": null,
            "minimum_range": null,
            "maximum_range": null,
            "notes": "APOA5 gene variant",
            "result": "TG"
          }
        ]
      }
    ]
  }
}



crelio:
{
  "Signing Doctor": [
    {
      "Signing Doctor 1": "Mr. Smith"
    },
    {
      "Signing Doctor 2": "Ms. Jones"
    }
  ],
  "orderNumber": "Order1234",
  "Patient Name": "John Doe",
  "fileInputReport": 1,
  "labPatientId": "Lab1234",
  "Test Name": "Blood Test",
  "CentreReportId": 64763796,
  "integrationCode": "Q123",
  "billReferral": "Referral1234",
  "labId": 437,
  "Sample Date": "2024-11-14",
  "billId": 17758,
  "dictionaryId": 314,
  "Report Id": 12345,
  "reportFormatAndValues": [
    {
      "value": "Normal",
      "reportFormat": {
        "isImage": 0,
        "lowerBoundFemale": "18",
        "criticalUpperFemale": "300",
        "descriptionFlag": 1,
        "lowerBoundMale": "18",
        "listField": 0,
        "otherFemale": "No issues",
        "criticalLowerMale": "50",
        "otherFlag": 0,
        "highlightFlag": 0,
        "upperBoundFemale": "200",
        "testName": "Blood Glucose",
        "dictionaryId": 314,
        "otherMale": "No issues",
        "upperBoundMale": "250",
        "testUnit": "mg/dL",
        "fileInput": 0,
        "integrationCode": "Q123",
        "criticalUpperMale": "300",
        "method": "Spectrophotometry",
        "criticalLowerFemale": "40"
      }
    },
    {
      "value": ">130",
      "reportFormat": {
        "isImage": 0,
        "lowerBoundFemale": "40",
        "criticalUpperFemale": "200",
        "descriptionFlag": 1,
        "lowerBoundMale": "50",
        "listField": 0,
        "otherFemale": "High cholesterol",
        "criticalLowerMale": "30",
        "otherFlag": 0,
        "highlightFlag": 1,
        "upperBoundFemale": "100",
        "testName": "LDL Cholesterol",
        "dictionaryId": 315,
        "otherMale": "High cholesterol",
        "upperBoundMale": "130",
        "testUnit": "mg/dL",
        "fileInput": 0,
        "integrationCode": "Q124",
        "criticalUpperMale": "200",
        "method": "Enzymatic",
        "criticalLowerFemale": "20"
      }
    },
    {
      "value": "<20",
      "reportFormat": {
        "isImage": 0,
        "lowerBoundFemale": "20",
        "criticalUpperFemale": "100",
        "descriptionFlag": 1,
        "lowerBoundMale": "20",
        "listField": 0,
        "otherFemale": "Vitamin D deficiency",
        "criticalLowerMale": "10",
        "otherFlag": 0,
        "highlightFlag": 1,
        "upperBoundFemale": "50",
        "testName": "Vitamin D",
        "dictionaryId": 316,
        "otherMale": "Vitamin D deficiency",
        "upperBoundMale": "50",
        "testUnit": "ng/mL",
        "fileInput": 0,
        "integrationCode": "Q125",
        "criticalUpperMale": "100",
        "method": "Immunoassay",
        "criticalLowerFemale": "10"
      }
    },
    {
      "value": ">150",
      "reportFormat": {
        "isImage": 0,
        "lowerBoundFemale": "50",
        "criticalUpperFemale": "400",
        "descriptionFlag": 1,
        "lowerBoundMale": "50",
        "listField": 0,
        "otherFemale": "Elevated triglycerides",
        "criticalLowerMale": "40",
        "otherFlag": 0,
        "highlightFlag": 1,
        "upperBoundFemale": "150",
        "testName": "Triglycerides",
        "dictionaryId": 317,
        "otherMale": "Elevated triglycerides",
        "upperBoundMale": "150",
        "testUnit": "mg/dL",
        "fileInput": 0,
        "integrationCode": "Q126",
        "criticalUpperMale": "400",
        "method": "Colorimetric",
        "criticalLowerFemale": "40"
      }
    }
  ],
  "Report Date": "2024-11-14",
  "status": "Pending",
  "testCode": "BG001",
  "userDetailsId": 1234,
  "Gender": "Male",
  "Age": "30",
  "Accession Date": "2024-11-14T06:05:29Z",
  "isSigned": 1,
  "webhookId": 5678,
  "Patient Id": 1001,
  "labReportId": 54321,
  "reportDate": "2024-11-14",
  "alternateEmail": "patient@example.com",
  "Approval Date": "2024-11-15",
  "Contact No": "+1234567890",
  "testID": 708075
}
