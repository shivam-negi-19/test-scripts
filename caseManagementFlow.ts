// Placeholder function to simulate sending confirmation to the client
async function sendClientConfirmation(caseId: number, patientId: number, result: TestResultType): Promise<void> {
  // Simulate sending a confirmation (e.g., email/SMS) to the client
  console.log(`Sending confirmation for case ${caseId}, patient ${patientId}: Result ${result.result} processed.`);
  // In a real system, this could call an API or messaging service
}

// Main processing function for test results with detailed flow for Case Management Flow.
export async function processTestResults(accountId: number = 1) {
  // Step 1: Fetch all unprocessed test results from the database (Positive/abnormal and NeedProcess=not set yet)
  const results = await fetchUnprocessedTestResults();

  // Step 2: Loop through each test result to process it individually
  for (const result of results) {
    // Step 3: Classify the test result as positive/abnormal or negative/normal
    const isPositive = await classifyTestResult(result); // True = positive/abnormal, False = negative/normal

    // Action: Check if the result is negative/normal, exit the CaseManagement Flow
    if (!isPositive) {
      // Description: Result is negative (normal), no further action needed in Case Management
      // Flow: Mark as processed and skip to the next result
      await endProcessingForNormalResult(result);
      console.log(`Result ${result.id} is negative/normal, processing ended.`);
      continue; // Move to next result
    } else {
      // Description: Result is positive/abnormal, proceed with Case Management checks
      console.log(`Result ${result.id} is positive/abnormal, proceeding to scope check.`);
    }

    // Step 4: Check if the product is in Case Management scope for this account (Global setting and Account Setting should be True )
    const inScope = await checkCaseManagementScope(result, accountId);

    // Action: Check if the result is out of Case Management scope
    if (!inScope) {
      // Description: Result is positive/abnormal but not in scope (e.g., global/account settings disable it)
      // Flow: Mark as processed, no case created, no confirmation sent
      await endProcessingForNormalResult(result);
      console.log(`Result ${result.id} is out of Case Management scope, processing ended.`);
      continue; // Move to next result
    } else {
      // Description: Result is in scope, proceed with Case Management processing
      console.log(`Result ${result.id} is in scope, checking if already processed.`);
    }

    // Step 5: Check if this result has already been processed into a case.
    // check if the result/test.id is already in CaseManagementProductAndBundleModel or not
    const isProcessed = await isTestResultProcessed(result.id);

    // Action: Check if the result was previously processed
    if (isProcessed) {
      // Description: Result already linked to a case, avoid duplicate processing
      // Flow: Skip to next result, no confirmation needed (already sent previously)
      console.log(`Result ${result.id} already processed, skipping.`);
      continue; // Move to next result
    } else {
      // Description: Result is new, proceed to case creation or update
      console.log(`Result ${result.id} is new, checking for existing case.`);
    }

    // Step 6: Check if an open case exists for this patient.
    // Check if the Patient is already in Test_result table.
    const existingCase = await findExistingOpenCase(result.patientId);
    let caseId: number;

    // Action: Decide whether to update an existing case or create a new one
    if (existingCase) {
      // Description: An open case exists for this patient, update it with the new result
      // Flow: Update case, link result, send confirmation
      caseId = existingCase.id;
      await updateExistingCase(caseId, existingCase); // Flag new positive/abnormal result
      console.log(`Updated existing case ${caseId} for patient ${result.patientId}.`);
    } else {
      // Description: No open case exists, create a new one for this patient
      // Flow: Create case, assign manager, link manager, link result, send confirmation
      const { caseId: newCaseId, caseManagerId } = await createNewCase(result);
      caseId = newCaseId;
      await linkCaseManager(caseId, caseManagerId);
      console.log(`Created new case ${caseId} for patient ${result.patientId}, assigned to manager ${caseManagerId}.`);
    }

    // Step 7: Link the test result to the case (new or existing)
    await linkTestResultToCase(caseId, result);
    console.log(`Linked result ${result.id} to case ${caseId}.`);

    // Step 8: Send client confirmation for the processed positive/abnormal result
    await sendClientConfirmation(caseId, result.patientId, result);
    // Description: Notify client (patient/provider) that a case has been created or updated
    // Flow: Confirmation sent after case processing is complete

    // Step 9: Mark the test result as fully processed
    await endProcessingForNormalResult(result);
    console.log(`Result ${result.id} processing complete, marked as done.`);

    // End of loop, move to next result
  }
}
