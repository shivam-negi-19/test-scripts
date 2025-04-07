/* eslint-disable @typescript-eslint/no-explicit-any */
import sgMail from '@sendgrid/mail';
import { CaseNotification, CaseManager, Case } from '../model/testCaseManagement';

// Set SendGrid API key from environment variable
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

export async function sendEmail(
  templateId: number,
  caseId: string,
  email: string,
  name: string,
  replacements: Record<string, string>
): Promise<void> {
  try {
    console.log(`Fetching template ${templateId} for case ${caseId}`);
    const template = await CaseNotification.getTemplate(templateId);
    console.log(`Template ${templateId} retrieved:`, template);

    if (!template || !template.subject || !template.body) {
      throw new Error(`Template ${templateId} is invalid or missing subject/body`);
    }

    let subject = template.subject;
    let body = template.body;
    console.log(`Processing replacements for email to ${email}`);
    for (const [key, value] of Object.entries(replacements)) {
      console.log(`Replacing {{${key}}} with "${value}"`);
      subject = subject.replace(`{{${key}}}`, value);
      body = body.replace(`{{${key}}}`, value);
    }

    const msg = {
      to: "shivam@advantageaieng.com",
      from: 'shivamsinghaws@gmail.com', // Replace with your verified SendGrid sender email
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>'),
    };
    console.log(`Sending email to ${email} with subject: "${subject}"`);
    await sgMail.send(msg);
    console.log(`Email successfully sent to ${email} with templateId ${templateId} for case ${caseId}`);
  } catch (error) {
    console.error(`Failed to send email to ${email} with templateId ${templateId} for case ${caseId}:`, error);
    throw error;
  }
}

export function renderTemplate(
  template: any,
  caseData: any,
  caseManager: any
): { subject: string; replacements: Record<string, string> } {
  console.log(`Rendering template for case ${caseData.id} with manager ${caseManager.id}`);
  if (!template.subject || !template.body) {
    throw new Error('Template missing subject or body');
  }

  const caseURL = `https://your-portal.com/case-management/${caseData.id}?token=${Buffer.from(
    `${caseData.id}:${caseManager.id}`
  ).toString('base64')}`;
  const patientDOB = '01/01/1990'; // Placeholder
  console.log(`Generated case URL: ${caseURL}`);

  const subject = template.subject.replace('{{patientDOB}}', patientDOB);
  console.log(`Rendered subject: "${subject}"`);

  const replacements = {
    caseManagerName: caseManager.name || 'Case Manager',
    patientDOB,
    caseURL,
  };
  console.log('Generated replacements:', replacements);

  return { subject, replacements };
}
export async function processNotifications(): Promise<void> {
  try {
    console.log('Starting case notification process');

    console.log('Fetching cases with new results');
    const cases = await Case.getCasesWithNewResults();
    console.log(`Retrieved ${cases.length} cases with new results:`, cases);

    const filteredCases = cases.filter((c: any) => c.caseManagerId !== null);
    console.log(`Filtered to ${filteredCases.length} cases with valid caseManagerId`);

    for (const caseData of filteredCases) {
      console.log(`Processing case ${caseData.id}`);

      if (!caseData.id || !caseData.caseManagerId) {
        console.warn(`Skipping case ${caseData.id}: missing id or caseManagerId`, caseData);
        continue;
      }

      console.log(`Fetching case manager for ID ${caseData.caseManagerId}`);
      const caseManager = await CaseManager.getCaseManager(caseData.caseManagerId);
      console.log(`Case manager retrieved:`, caseManager);

      if (!caseManager || !caseManager.name) {
        console.warn(`Skipping case ${caseData.id}: invalid or missing case manager`, caseManager);
        continue;
      }

      console.log(`Fetching notifications for case ${caseData.id}`);
      const notifications = await CaseNotification.getByCaseId(caseData.id);
      console.log(`Found ${notifications.length} existing notifications:`, notifications);

      const initialSent = notifications.find((n: any) => n.templateID === 363);
      const reminderCount = notifications.filter((n: any) => n.templateID === 364).length;
      const lastNotification = notifications[0]; // Newest first
      const oneDayInMs = 0;

      console.log(`Initial notification (template 363) sent: ${!!initialSent}`, initialSent);
      console.log(`Reminder count (template 364): ${reminderCount}`);
      console.log(`Last notification:`, lastNotification);

      if (!initialSent) {
        console.log(`Preparing initial notification (template 363) for case ${caseData.id}`);
        const template = await CaseNotification.getTemplate(363);
        console.log(`Template 363 retrieved:`, template);

        if (!template || !template.subject || !template.body) {
          console.warn(`Skipping case ${caseData.id}: invalid template 363`, template);
          continue;
        }

        const { subject, replacements } = renderTemplate(template, caseData, caseManager);
        console.log(`Sending initial email for case ${caseData.id} with subject: "${subject}"`);
        await sendEmail(363, caseData.id, 'shivamsingh.comp1999@gmail.com', caseManager.name, replacements);

        console.log(`Creating notification record for initial email (template 363)`);
        await CaseNotification.create({ caseId: caseData.id, caseManagerId: caseManager.id, templateID: 363 });
        console.log(`Initial notification sent and recorded for case ${caseData.id}`);
      } else if (reminderCount < 3 && lastNotification && Date.now() - new Date(lastNotification.sentAt).getTime() >= oneDayInMs) {
        console.log(`Preparing reminder #${reminderCount + 1} (template 364) for case ${caseData.id}`);
        const template = await CaseNotification.getTemplate(364);
        console.log(`Template 364 retrieved:`, template);

        if (!template || !template.subject || !template.body) {
          console.warn(`Skipping case ${caseData.id}: invalid template 364`, template);
          continue;
        }

        const { subject, replacements } = renderTemplate(template, caseData, caseManager);
        console.log(`Sending reminder email for case ${caseData.id} with subject: "${subject}"`);
        await sendEmail(364, caseData.id, 'shivamsinghaws@gmail.com', caseManager.name, replacements);

        console.log(`Creating notification record for reminder #${reminderCount + 1} (template 364)`);
        await CaseNotification.create({ 
          caseId: caseData.id, 
          caseManagerId: caseManager.id, 
          templateID: 364, 
          reminderCount: reminderCount + 1 
        });
        console.log(`Reminder #${reminderCount + 1} sent and recorded for case ${caseData.id}`);
      } else {
        console.log(`No action needed for case ${caseData.id}: initial sent=${!!initialSent}, reminders=${reminderCount}, time since last=${lastNotification ? Math.floor((Date.now() - new Date(lastNotification.sentAt).getTime()) / oneDayInMs) : 'N/A'} days`);
      }
    }

    console.log('Finished processing all notifications');
  } catch (error) {
    console.error('Error in processNotifications:', error);
  }
}
