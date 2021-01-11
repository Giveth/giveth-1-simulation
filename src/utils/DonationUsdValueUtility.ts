const BigNumber = require('bignumber.js');
import { getTokenByAddress } from './tokenUtility';
import { getLogger } from './logger';
import {getHourlyCryptoConversion} from "./giveth-feathers-service";
import {DonationMongooseDocument} from "../models/donations.model";
const logger = getLogger();

export async function setDonationUsdValue(donation :DonationMongooseDocument) {
    const { createdAt, tokenAddress, amount } = donation;
    try {
      const token = getTokenByAddress(tokenAddress);
      const { symbol } = token;
      const { rate } = await getHourlyCryptoConversion(createdAt.getTime(), symbol, 'USD');
      const usdValue = Number(
        new BigNumber(amount.toString())
          .div(10 ** 18)
          .times(Number(rate))
          .toFixed(2),
      );
      donation.usdValue = usdValue;
    } catch (e) {
      logger.error('setDonationUsdValue error ', e)
    }
  }

