/* eslint-disable @typescript-eslint/no-explicit-any */
import Cron from 'node-cron';

import './triggers';
import ENV from '../env';
import logger from '../logger';
import { CRONS, QUEUE_STATUS } from '../constants';
import { CronQueue, Crons } from '../model';
import { CronBullQueue, CronData, CronQueueData } from '../types';
import { createQueue } from '../helpers';
import { notifyAboutArrivedInbound, shipmentSync, shipmentTracking } from './shipment';
import { notifyNewFax, sendFaxRecipients } from './fax';
import { getTestsAndProfileFromCrelio } from './crelio';
import { sendNotificationToPatient } from './testResults';
import { createFailedSpotDxOrders, createSpotDxOrders, spotDxStatusOrder } from './spotDx';
// import { processNotifications } from '../helpers/notification';
const ATTEMPTS = Number(ENV.CRON_RETRY_COUNT || 3);
const { RUN_GET_TEST_AND_PROFILE_CRON } = process.env;

const cronHandlers: any = {
  [CRONS.SHIPMENT_TRACKING]: shipmentTracking,
  [CRONS.NOTIFY_ARRIVED_INBOUND]: notifyAboutArrivedInbound,
  [CRONS.NOTIFY_NEW_FAX]: notifyNewFax,
  [CRONS.SEND_FAX_RECIPIENTS]: sendFaxRecipients,
  [CRONS.SPOT_DX_CREATE_ORDERS]: createSpotDxOrders,
  [CRONS.SPOT_DX_ORDER_STATUS]: spotDxStatusOrder,
  [CRONS.SPOT_DX_FAILED_ORDERS]: createFailedSpotDxOrders,
  [CRONS.SHIPMENT_SYNC]: shipmentSync
};

Cron.schedule('*/2 * * * *', async () => {
  logger.info('Executing the cron queue');
  const crons: CronData[] = await Crons.getBys({ active: 1 });
  const allQueues: CronBullQueue[] = crons.map((cron: CronData) =>
    createQueue(cron.id, cron.cron_type, cronHandlers[cron.cron_type])
  );
  Promise.all(
    allQueues.map(async ({ cronId, bullQueue }: CronBullQueue) => {
      const pendingQueues: CronQueueData[] = await CronQueue.getBys({
        cron_id: cronId,
        status: QUEUE_STATUS.PENDING
      });
      Promise.all(
        pendingQueues.map(async (queue: CronQueueData) => {
          bullQueue.add(queue, { attempts: ATTEMPTS });
          await CronQueue.updateStatus(queue.id, QUEUE_STATUS.QUEUED);
        })
      );
    })
  );
});

// cron to send mail for every 15 minutes
// Cron.schedule('*/15 * * * *', async () => {
//   logger.info('Cron running every 15 minutes');
//   masterWorkFlowWrapper();
//   arrivedAtLabShipmentEmailTrigger();
//   getOrderTestFromMyLabBox();
//   shipmentSync();
// });

// cron to run for every monday at 9 am
Cron.schedule('0 9 * * 1', async () => {
  logger.info('Cron running every monday at 9 am');
  if (RUN_GET_TEST_AND_PROFILE_CRON === 'true') {
    getTestsAndProfileFromCrelio();
  }
});

Cron.schedule('0 0 * * *', async () => {
  logger.info('Cron running every day at 12 am.');
  sendNotificationToPatient();
});


// Cron.schedule('*/20 * * * * *', async () => {
//   console.log("Process Notification is running");
//   await processNotifications().catch(err => console.error('Error running notifications:', err));
//   console.log("Process Notification is end");
// });
