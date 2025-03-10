const BigNumber = require('bignumber.js');
const { MultiCall } = require('eth-multicall');
const { polygonWeb3: web3, multicallAddress } = require('../../../utils/web3');

const ERC20 = require('../../../abis/ERC20.json');
const { MINUTELY_HPY, POLYGON_CHAIN_ID } = require('../../../constants');
const fetchPrice = require('../../../utils/fetchPrice');
const getBlockNumber = require('../../../utils/getBlockNumber');
const getFarmWithTradingFeesApy = require('../../../utils/getFarmWithTradingFeesApy');
const { getTradingFeeAprSushi, getTradingFeeApr } = require('../../../utils/getTradingFeeApr');
const { sushiClient } = require('../../../apollo/client');

const getMasterChefApys = async masterchefParams => {
  let apys = {};

  masterchefParams.pools = [
    ...(masterchefParams.pools ?? []),
    ...(masterchefParams.singlePools ?? []),
  ];

  const tradingAprs = await getTradingAprs(masterchefParams);
  const farmApys = await getFarmApys(masterchefParams);

  masterchefParams.pools.forEach((pool, i) => {
    const simpleApy = farmApys[i];
    const tradingApr = tradingAprs[pool.address.toLowerCase()] ?? new BigNumber(0);
    const apy = getFarmWithTradingFeesApy(simpleApy, tradingApr, MINUTELY_HPY, 1, 0.955);

    if (masterchefParams.log) {
      console.log(pool.name, simpleApy.valueOf(), tradingApr.valueOf(), apy);
    }

    apys = { ...apys, ...{ [pool.name]: apy } };
  });

  return apys;
};

const getTradingAprs = async params => {
  let tradingAprs = [];
  const client = params.tradingFeeInfoClient;
  const fee = params.liquidityProviderFee;
  if (client && fee) {
    const pairAddresses = params.pools.map(pool => pool.address.toLowerCase());
    const getAprs = client === sushiClient ? getTradingFeeAprSushi : getTradingFeeApr;
    tradingAprs = await getAprs(client, pairAddresses, fee);
  }
  return tradingAprs;
};

const getFarmApys = async params => {
  const apys = [];

  const tokenPrice = await fetchPrice({ oracle: params.oracle, id: params.oracleId });
  const { multiplier, blockRewards, totalAllocPoint } = await getMasterChefData(params);
  const { balances, allocPoints } = await getPoolsData(params);

  for (let i = 0; i < params.pools.length; i++) {
    const pool = params.pools[i];

    const oracle = pool.oracle ?? 'lps';
    const id = pool.oracleId ?? pool.name;
    const stakedPrice = await fetchPrice({ oracle, id });
    const totalStakedInUsd = balances[i].times(stakedPrice).dividedBy(pool.decimals ?? '1e18');

    const poolBlockRewards = blockRewards
      .times(multiplier)
      .times(allocPoints[i])
      .dividedBy(totalAllocPoint);

    const secondsPerBlock = params.secondsPerBlock ?? 2;
    const secondsPerYear = 31536000;
    const yearlyRewards = poolBlockRewards.dividedBy(secondsPerBlock).times(secondsPerYear);
    const yearlyRewardsInUsd = yearlyRewards.times(tokenPrice).dividedBy(params.decimals);

    if (params.log) {
      console.log(pool.name, 'staked:', totalStakedInUsd.valueOf(), yearlyRewardsInUsd.valueOf());
    }

    apys.push(yearlyRewardsInUsd.dividedBy(totalStakedInUsd));
  }

  return apys;
};

const getMasterChefData = async params => {
  const masterchefContract = new web3.eth.Contract(params.masterchefAbi, params.masterchef);
  let multiplier = new BigNumber(1);
  if (params.hasMultiplier) {
    const blockNum = await getBlockNumber(POLYGON_CHAIN_ID);
    multiplier = new BigNumber(
      await masterchefContract.methods.getMultiplier(blockNum - 1, blockNum).call()
    );
  }
  const blockRewards = new BigNumber(
    await masterchefContract.methods[params.tokenPerBlock]().call()
  );
  const totalAllocPoint = new BigNumber(await masterchefContract.methods.totalAllocPoint().call());
  return { multiplier, blockRewards, totalAllocPoint };
};

const getPoolsData = async params => {
  const masterchefContract = new web3.eth.Contract(params.masterchefAbi, params.masterchef);
  const multicall = new MultiCall(web3, multicallAddress(POLYGON_CHAIN_ID));
  const balanceCalls = [];
  const allocPointCalls = [];
  params.pools.forEach(pool => {
    const tokenContract = new web3.eth.Contract(ERC20, pool.address);
    balanceCalls.push({
      balance: tokenContract.methods.balanceOf(params.masterchef),
    });
    allocPointCalls.push({
      allocPoint: masterchefContract.methods.poolInfo(pool.poolId),
    });
  });

  const res = await multicall.all([balanceCalls, allocPointCalls]);

  const balances = res[0].map(v => new BigNumber(v.balance));
  const allocPoints = res[1].map(v => v.allocPoint['1']);
  return { balances, allocPoints };
};

module.exports = getMasterChefApys;
