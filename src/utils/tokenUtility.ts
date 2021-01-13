import {ExtendedDonation, Token} from "./interfaces";

import BigNumber from "bignumber.js";

const config = require('config');

export const ANY_TOKEN = {
  name: 'ANY_TOKEN',
  address: '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF',
  foreignAddress: '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF',
  symbol: 'ANY_TOKEN',
  decimals: 18,
};
let tokensByAddress;

export function getTokenByAddress(address: string): Token {
  if (!tokensByAddress) {
    tokensByAddress = {};
    config.get('tokenWhitelist').forEach(token => {
      tokensByAddress[token.address] = token;
    });
  }
  tokensByAddress[ANY_TOKEN.address] = ANY_TOKEN;
  return tokensByAddress[address];
}


let tokensByForeignAddress;

export function getTokenByForeignAddress(foreignAddress: string): Token {
  if (!tokensByForeignAddress) {
    tokensByForeignAddress = {};
    config.get('tokenWhitelist').forEach(token => {
      tokensByForeignAddress[token.foreignAddress] = token;
    });
    tokensByForeignAddress[ANY_TOKEN.foreignAddress] = ANY_TOKEN;
  }
  return tokensByForeignAddress[foreignAddress];
}

export function getTokenSymbolByAddress(address: string): string {
  return address && getTokenByAddress(address) && getTokenByAddress(address).symbol
}

const symbolDecimalsMap: {
  [key: string]: {
    cutoff: BigNumber
  }
} = {};
config.get('tokenWhitelist').forEach(({symbol, decimals}) => {
  symbolDecimalsMap[symbol] = {
    cutoff: new BigNumber(10 ** (18 - Number(decimals))),
  };
});

export function getTokenCutoff(symbol: string): {
  cutoff: BigNumber
} {
  return  symbolDecimalsMap[symbol]
}