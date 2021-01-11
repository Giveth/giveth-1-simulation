import {EventInterface, TransferInfoInterface} from "./interfaces";
import {AdminTypes} from "../models/pledgeAdmins.model";

/**
 * Determine if this transfer was a return of excess funds of an over-funded milestone
 * @param options
 */
export function isReturnTransfer(options:
                                   {
                                     transferInfo: TransferInfoInterface,
                                     txHashTransferEventMap: object
                                   }): boolean {

  const {txHashTransferEventMap, transferInfo} = options;
  const {fromPledge, fromPledgeAdmin, toPledgeId, txHash, fromPledgeId} = transferInfo;
  // currently only milestones will can be over-funded
  if (fromPledgeId === '0' || !fromPledgeAdmin || fromPledgeAdmin.type !== AdminTypes.MILESTONE) {
    return false;
  }

  const transferEventsInTx = txHashTransferEventMap[txHash];

  // ex events in return case:
  // Transfer(from: 1, to: 2, amount: 1000)
  // Transfer(from: 2, to: 1, amount: < 1000)
  return transferEventsInTx.some(
    (e: EventInterface) =>
      // it may go directly to fromPledge.oldPledge if this was delegated funds
      // being returned b/c the intermediary pledge is the pledge w/ the intendedProject
      [e.returnValues.from, fromPledge.oldPledge].includes(toPledgeId) &&
      e.returnValues.to === fromPledgeId,
  );
}