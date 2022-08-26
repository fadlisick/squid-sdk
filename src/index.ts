import {
  AxelarQueryAPI,
  AxelarQueryAPIConfig,
  EvmChain,
  GasToken
} from "@axelar-network/axelarjs-sdk";
import { BigNumber, ethers } from "ethers";
import axios, { AxiosInstance } from "axios";
import * as dotenv from "dotenv";

import {
  Allowance,
  Approve,
  ChainData,
  ChainsData,
  Config,
  ExecuteRoute,
  GetRoute,
  GetRouteResponse,
  TokenData
} from "./types";

import erc20Abi from "./abi/erc20.json";
import { getChainData } from "./utils/getChainData";
import { getTokenData } from "./utils/getTokenData";
import { nativeTokenConstant, uint256MaxValue } from "./constants";

dotenv.config();

const baseUrl = process.env.baseUrl;

export class Squid {
  private axiosInstance: AxiosInstance;

  public inited = false;
  public config: Config | undefined;
  public tokens: TokenData[] = [] as TokenData[];
  public chains: ChainsData = {} as ChainsData;

  constructor(config?: Config) {
    this.axiosInstance = axios.create({
      baseURL: config?.baseUrl || baseUrl,
      headers: {
        // 'api-key': config.apiKey
      }
    });

    if (config) {
      this.config = config;
    }
  }

  private validateInit() {
    if (!this.inited) {
      throw new Error(
        "SquidSdk must be inited! Please call the SquidSdk.init method"
      );
    }
  }

  private async validateBalanceAndApproval({
    tokenAddress,
    sourceAmount,
    signer,
    sourceChain,
    infiniteApproval
  }: {
    tokenAddress: string;
    sourceAmount: string;
    signer: ethers.Wallet;
    sourceChain: ChainData;
    infiniteApproval?: boolean;
  }) {
    const _sourceAmount = BigInt(sourceAmount);
    const srcProvider = new ethers.providers.JsonRpcProvider(sourceChain.rpc);
    const srcTokenContract = new ethers.Contract(
      tokenAddress,
      erc20Abi,
      srcProvider
    );

    const balance = await srcTokenContract.balanceOf(signer.address);

    if (balance < _sourceAmount) {
      throw new Error(
        `Insufficent funds for account: ${signer.address} on chain ${sourceChain.chainId}`
      );
    }

    const allowance = await srcTokenContract.allowance(
      signer.address,
      sourceChain.squidContracts.squidMain
    );

    if (allowance < _sourceAmount) {
      let amountToApprove: string | bigint = uint256MaxValue;

      if (infiniteApproval === false) {
        amountToApprove = _sourceAmount;
      }

      if (
        this.config?.executionSettings?.infiniteApproval === false &&
        !infiniteApproval
      ) {
        amountToApprove = uint256MaxValue;
      }

      const approveTx = await srcTokenContract
        .connect(signer)
        .approve(sourceChain.squidContracts.squidMain, amountToApprove);
      await approveTx.wait();
    }
  }

  public async init() {
    try {
      const response = await this.axiosInstance.get("/api/sdk-info");
      this.tokens = response.data.data.tokens;
      this.chains = response.data.data.chains;
      this.inited = true;
    } catch (error) {
      throw new Error(`Squid inititalization failed ${error}`);
    }
  }

  public setConfig(config: Config) {
    this.axiosInstance = axios.create({
      baseURL: config.baseUrl || baseUrl,
      headers: {
        // 'api-key': config.apiKey
      }
    });
    this.config = config;
  }

  public async getRoute(params: GetRoute): Promise<GetRouteResponse> {
    this.validateInit();

    const response = await this.axiosInstance.get("/api/route", { params });

    return {
      route: response.data.route
    };
  }

  public async executeRoute({
    signer,
    route,
    executionSettings
  }: ExecuteRoute): Promise<ethers.providers.TransactionResponse> {
    this.validateInit();

    const { transactionRequest, params } = route;

    const sourceChain = getChainData(
      this.chains as ChainsData,
      params.sourceChainId
    );
    const destinationChain = getChainData(
      this.chains as ChainsData,
      params.destinationChainId
    );
    if (!sourceChain) {
      throw new Error(`sourceChain not found for ${params.sourceChainId}`);
    }
    if (!destinationChain) {
      throw new Error(
        `destinationChain not found for ${params.destinationChainId}`
      );
    }

    const sourceIsNative = params.sourceTokenAddress === nativeTokenConstant;

    if (!sourceIsNative) {
      await this.validateBalanceAndApproval({
        tokenAddress: params.sourceTokenAddress,
        sourceAmount: params.sourceAmount,
        sourceChain,
        infiniteApproval: executionSettings?.infiniteApproval,
        signer
      });
    }

    const sdk = new AxelarQueryAPI({
      environment: this.config?.environment as string
    } as AxelarQueryAPIConfig);

    let gasFee;
    try {
      gasFee = await sdk.estimateGasFee(
        sourceChain.nativeCurrency.name as EvmChain,
        destinationChain.nativeCurrency.name as EvmChain,
        destinationChain.nativeCurrency.symbol as GasToken,
        transactionRequest.destinationChainGas
      );
    } catch (error) {
      // TODO: we need a backup
      console.warn("error: fetching gasFee:", error);
      gasFee = "3513000021000000";
    }

    const value = sourceIsNative
      ? ethers.BigNumber.from(params.sourceAmount).add(
          ethers.BigNumber.from(gasFee)
        )
      : ethers.BigNumber.from(gasFee);

    const tx = {
      to: sourceChain.squidContracts.squidMain,
      data: transactionRequest.data,
      value: value
    };

    await signer.signTransaction(tx);
    return await signer.sendTransaction(tx);
  }

  public async allowance(params: Allowance): Promise<BigNumber> {
    this.validateInit();

    const { owner, spender, tokenAddress } = params;

    const token = getTokenData(this.tokens as TokenData[], tokenAddress);
    if (!token) {
      throw new Error("Unsupported token");
    }

    const chain = getChainData(
      this.chains as ChainsData,
      token?.chainId as number
    );
    if (!chain) {
      throw new Error("Unsupported chain");
    }

    const provider = new ethers.providers.JsonRpcProvider(chain.rpc);
    const contract = new ethers.Contract(token.address, erc20Abi, provider);

    return await contract.allowance(owner, spender);
  }

  public async approve(
    params: Approve
  ): Promise<ethers.providers.TransactionResponse> {
    this.validateInit();

    const { signer, spender, tokenAddress, amount } = params;

    const token = getTokenData(this.tokens as TokenData[], tokenAddress);
    if (!token) {
      throw new Error("Unsupported token");
    }

    const chain = getChainData(
      this.chains as ChainsData,
      token?.chainId as number
    );
    if (!chain) {
      throw new Error("Unsupported chain");
    }

    const contract = new ethers.Contract(token.address, erc20Abi, signer);
    return await contract.approve(spender, amount || uint256MaxValue);
  }
}

export * from "./types";
