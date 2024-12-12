import WebSocket from 'ws';
import { Connection } from "@solana/web3.js";
import http from "http";
import csv from 'csv-parse';
import fs from 'fs';
import { Client } from 'pg';
import './logger';
import { AMM_TYPES, JUPITER_V6_PROGRAM_ID } from './constant';
import { FeeEvent, SwapEvent, TransactionWithMeta } from './types';
import { InstructionParser } from './lib/instruction-parser';
import { getEvents } from './lib/get-events';
import { BN, Program, Provider, Event } from '@coral-xyz/anchor';
import { IDL, Jupiter } from './idl/jupiter';
import { PublicKey } from '@solana/web3.js';
import { DecimalUtil, getPriceInUSDByMint } from './lib/utils';
import Decimal from 'decimal.js';
import got from 'got';

export type SwapAttributes = {
    owner: string;
    transferAuthority: string;
    programId: string;
    signature: string;
    timestamp: Date;
    legCount: number;
    volumeInUSD: number;
    inSymbol: string;
    inAmount: BigInt;
    inAmountInDecimal?: number;
    inAmountInUSD: number;
    inMint: string;
    outSymbol: string;
    outAmount: BigInt;
    outAmountInDecimal?: number;
    outAmountInUSD: number;
    outMint: string;
    instruction: string;
    exactInAmount: BigInt;
    exactInAmountInUSD: number;
    exactOutAmount: BigInt;
    exactOutAmountInUSD: number;
    swapData: any[];
    feeTokenPubkey?: string;
    feeOwner?: string;
    feeSymbol?: string;
    feeAmount?: BigInt;
    feeAmountInDecimal?: number;
    feeAmountInUSD?: number;
    feeMint?: string;
    tokenLedger?: string;
    lastAccount: string; // This can be a tracking account since we don't have a way to know we just log it the last account.
};

type AccountInfo = {
    accountIndex: number,
    mint: string,
    uiTokenAmount: {
        uiAmount: number,
        decimals: number,
        amount: string,
        uiAmountString: string
    },
    owner: string,
    programId: string
}
type AccountInfoMap = Map<string, AccountInfo>;

export const program = new Program<Jupiter>(
    IDL,
    JUPITER_V6_PROGRAM_ID,
    {} as Provider
);

// Define types for request and transaction
interface TransactionSubscribeRequest {
    jsonrpc: string;
    id: number;
    method: string;
    params: [
        {
            accountInclude: string[];
        },
        {
            commitment: string;
            encoding: string;
            transactionDetails: string;
            showRewards: boolean;
            maxSupportedTransactionVersion: number;
        }
    ];
}

interface WebSocketMessage {
    params?: {
        result?: {
            transaction: unknown;
        };
    };
}

// Function to send a transaction subscription request
function sendRequest(ws: WebSocket, walletList: string[]): void {
    const request: TransactionSubscribeRequest = {
        jsonrpc: '2.0',
        id: 420,
        method: 'transactionSubscribe',
        params: [
            {
                accountInclude: walletList,
            },
            {
                commitment: 'confirmed',
                encoding: 'jsonParsed',
                transactionDetails: 'full',
                showRewards: true,
                maxSupportedTransactionVersion: 0,
            },
        ],
    };
    ws.send(JSON.stringify(request));
}

interface PriceData {
    [key: string]: {
        id: string;
        type: string;
        price: string;
        extraInfo: {
            lastSwappedPrice: {
                lastJupiterSellAt: number;
                lastJupiterSellPrice: string;
                lastJupiterBuyAt: number;
                lastJupiterBuyPrice: string;
            };
            quotedPrice: {
                buyPrice: string;
                buyAt: number;
                sellPrice: string;
                sellAt: number;
            };
            confidenceLevel: string;
            depth: {
                buyPriceImpactRatio: {
                    depth: { [key: string]: number };
                    timestamp: number;
                };
                sellPriceImpactRatio: {
                    depth: { [key: string]: number };
                    timestamp: number;
                };
            };
        };
    };
}

// Function to send a ping to the WebSocket server
function startPing(ws: WebSocket): void {
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
            console.log('Ping sent');
        }
    }, 30000); // Ping every 30 seconds
}

const reduceEventData = <T>(events: Event[], name: string) =>
    events.reduce((acc, event) => {
        if (event.name === name) {
            acc.push(event.data as T);
        }
        return acc;
    }, new Array<T>());

const processTransactionWithMeta = (tx: TransactionWithMeta) => {
    // Convert accountKeys to PublicKey
    tx.transaction.message.accountKeys = tx.transaction.message.accountKeys.map((accountKey) => {
        return {
            ...accountKey,
            pubkey: new PublicKey(accountKey.pubkey), // Convert to PublicKey
        };
    });

    // Map through each instruction and convert programId to PublicKey
    tx.transaction.message.instructions = tx.transaction.message.instructions.map((instruction) => {
        if (instruction.programId && typeof instruction.programId === "string") {
            return {
                ...instruction,
                programId: new PublicKey(instruction.programId), // Convert to PublicKey
            };
        }
        return instruction;
    });

    // If there are inner instructions, process them too
    tx.meta?.innerInstructions?.forEach((innerInstruction) => {
        innerInstruction.instructions = innerInstruction.instructions.map((instruction) => {
            if (instruction.programId && typeof instruction.programId === "string") {
                return {
                    ...instruction,
                    programId: new PublicKey(instruction.programId),
                };
            }
            return instruction;
        });
    });

    return tx;
};

let tokenUSDPrice: PriceData = {};

const client = new Client({
    host: '18.117.159.85',
    database: 'trading',
    user: 'creative_dev',
    password: 'DuBR0NCMAsRg1bu',
    port: 5000,
    ssl: {
        rejectUnauthorized: false // Bypass certificate validation
    }
})

async function testConnection() {
    try {
        await client.connect(); // Attempt to connect
        console.log('AWS Connection successful!');
    } catch (err) {
        console.error('Connection failed:', err.message);
    }
}

testConnection();

async function getUSDPriceForTokens(tokens: string) {
    try {
        let payload = (await got
            .get(`https://api.jup.ag/price/v2?ids=${tokens},So11111111111111111111111111111111111111112`)
            .json()) as any;

        if (payload['data'] === undefined)
            console.log(payload)
        tokenUSDPrice = payload['data'] as PriceData;

    } catch (e) {
        console.log(`coin not found: ${tokens}`);
        return;
    }

    return;
}

const safeNumber = (value: Decimal) => {
    if (value.isNaN() || !value.isFinite()) {
        return new Decimal(0) // or new Decimal(null), depending on your database schema
    }
    const maxPrecision = 50
    const maxScale = 18
    const maxValue = new Decimal(
        '9.999999999999999999999999999999999999999999999999E+31'
    ) // Adjust based on precision and scale
    const minValue = maxValue.negated()

    if (value.greaterThan(maxValue)) {
        return maxValue
    }
    if (value.lessThan(minValue)) {
        return minValue
    }

    // Ensure the value conforms to max precision and scale
    const scaledValue = value.toDecimalPlaces(maxScale);
    const truncatedValue = scaledValue.toPrecision(maxPrecision);

    return new Decimal(truncatedValue);
}

async function fetchWalletAddresses() {
    try {
        // Query to execute the dblink function
        const query = `
        SELECT t_wallet_address
        FROM dblink(
          'host=prod-trading.copaicjskl31.us-east-2.rds.amazonaws.com port=5000 dbname=trading user=creative_dev_lim password=6cVgAGualY9qO9c',
          'SELECT DISTINCT t_wallet_address FROM turnkey_wallets_sol'
        ) AS remote_data(t_wallet_address TEXT);
      `;

        // Execute the query
        const result = await client.query(query);

        // Process the result
        const walletAddresses = result.rows.map(row => row.t_wallet_address);

        // Return the wallet addresses if needed
        return walletAddresses;
    } catch (error) {
        console.error('Error executing query:', error);
        throw error;
    }
}

async function db_save_summary(swap: SwapAttributes) {
    const placeholders = `
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `;

    const query = `
    INSERT INTO sol_swap_events_cd (
        block_number,
        transaction_hash,
        wallet_address,
        token0_id,
        token0_symbol,
        token0_amount,
        token0_value_in_usd,
        token0_total_exchanged_usd,
        token1_id,
        token1_symbol,
        token1_amount,
        token1_value_in_usd,
        token1_total_exchanged_usd,
        sol_usd_price,
        created_at
    ) VALUES ${placeholders}`;

    const defaultDecimal = new Decimal(0);
    const value = [0,
        swap.signature,
        swap.owner,
        swap.inMint,
        '',
        safeNumber(swap.inAmountInDecimal ? new Decimal(swap.inAmountInDecimal) : defaultDecimal).toString(),
        tokenUSDPrice[swap.inMint].price ? tokenUSDPrice[swap.inMint].price : defaultDecimal.toString(),
        // safeNumber(swap.inAmountInUSD ? new Decimal(swap.inAmountInUSD): defaultDecimal).toString(),
        safeNumber(
            swap.inAmountInDecimal ? new Decimal(swap.inAmountInUSD) : defaultDecimal
        ).toString(),
        swap.outMint,
        '',
        safeNumber(swap.outAmountInDecimal ? new Decimal(swap.outAmountInDecimal) : defaultDecimal).toString(),
        tokenUSDPrice[swap.outMint].price ? tokenUSDPrice[swap.outMint].price : defaultDecimal.toString(),
        // safeNumber(swap.outAmountInUSD ? new Decimal(swap.outAmountInUSD): defaultDecimal).toString(),
        safeNumber(
            swap.outAmountInDecimal ? new Decimal(swap.outAmountInUSD) : defaultDecimal
        ).toString(),
        tokenUSDPrice['So11111111111111111111111111111111111111112'].price,
        swap.timestamp.toISOString()];
    try {
        await client.query(query, value);
    } catch (err) {
        console.error('Error saving batch of events', err);
        fs.appendFile('./logs/error.txt', `Error: ${err}\nQuery: ${query}\nValues: ${JSON.stringify(swap)}\n`, (err) => {
            if (err) console.error('Error writing log file', err);
        });
    }
}

async function db_save_batch(swap: SwapAttributes) {
    const BATCH_SIZE = 100;
    const COLUMN_COUNT = 15;

    const batches = [];
    const swapData = swap.swapData;

    for (let i = 0; i < swapData.length; i += BATCH_SIZE) {
        batches.push(swapData.slice(i, i + BATCH_SIZE));
    }

    for (const batch of batches) {
        const values: (string | number)[] = [];
        const placeholders = batch
            .map((_, i) => {
                const offset = i * COLUMN_COUNT;
                return `(${Array.from({ length: COLUMN_COUNT }, (_, j) => `$${offset + j + 1}`).join(',')})`;
            })
            .join(',');

        for (const event of batch) {
            const defaultDecimal = new Decimal(0);
            values.push(
                0,
                swap.signature,
                swap.owner,
                event.inMint,
                '',
                safeNumber(event.inAmountInDecimal ?? defaultDecimal).toString(),
                safeNumber(event.inAmountInUSD ?? defaultDecimal).toString(),
                safeNumber(
                    swap.inAmountInDecimal ? new Decimal(swap.inAmountInDecimal) : defaultDecimal
                ).toString(),
                event.outMint,
                '',
                safeNumber(event.outAmountInDecimal ?? defaultDecimal).toString(),
                safeNumber(event.outAmountInUSD ?? defaultDecimal).toString(),
                safeNumber(
                    swap.outAmountInDecimal ? new Decimal(swap.outAmountInDecimal) : defaultDecimal
                ).toString(),
                new Decimal(0).toString(),
                swap.timestamp.toISOString()
            );
        }

        const query = `
        INSERT INTO sol_swap_events_cd (
            block_number,
            transaction_hash,
            wallet_address,
            token0_id,
            token0_symbol,
            token0_amount,
            token0_value_in_usd,
            token0_total_exchanged_usd,
            token1_id,
            token1_symbol,
            token1_amount,
            token1_value_in_usd,
            token1_total_exchanged_usd,
            sol_usd_price,
            created_at
        ) VALUES ${placeholders}`;

        try {
            await client.query(query, values);
        } catch (err) {
            console.error('Error saving batch of events', err);
            fs.appendFile('./logs/error.txt', `Error: ${err}\nQuery: ${query}\nValues: ${JSON.stringify(values)}\n`, (err) => {
                if (err) console.error('Error writing log file', err);
            });
        }
    }
}

// Function to parse a transaction (to be implemented as per use case)
async function parseTransaction(tx: TransactionWithMeta): Promise<SwapAttributes | undefined> {
    const start_time = new Date()

    if (tx.meta.err) {
        console.log(`Failed transaction ${tx.transaction.signatures[0]} : ${tx.meta.err}`);
        return;
    }

    console.log(start_time, tx.transaction.signatures[0], `transaction count: ${tx.meta.innerInstructions.length}`)

    const accountInfosMap: AccountInfoMap = new Map();
    const programId = JUPITER_V6_PROGRAM_ID;
    tx = processTransactionWithMeta(tx);

    const logMessages = tx.meta.logMessages;
    if (!logMessages) {
        throw new Error("Missing log messages...");
    }

    for (let j = 0; j < tx.meta.postTokenBalances.length; ++j) {
        const account = tx.meta.postTokenBalances[j]
        accountInfosMap.set(account.mint, account)
    }

    for (let j = 0; j < tx.meta.preTokenBalances.length; ++j) {
        const account = tx.meta.preTokenBalances[j]
        accountInfosMap.set(account.mint, account)
    }

    // var account2info = new Map()
    // for (let idx = 0; idx < tx.transaction.message.accountKeys.length; ++idx) {
    //     const account = tx.transaction.message.accountKeys[idx]
    //     const info = accountIndex2info.get(idx)
    //     if (info == null) continue
    //     account2info.set(account.pubkey.toString(), {
    //         mint: info.mint,
    //         decimals: info.uiTokenAmount.decimals
    //     })
    // }

    const parser = new InstructionParser(programId);
    const events = getEvents(program, tx);

    const swapEvents = reduceEventData<SwapEvent>(events, "SwapEvent");
    const feeEvent = reduceEventData<FeeEvent>(events, "FeeEvent")[0];

    if (swapEvents.length === 0) {
        // Not a swap event, for example: https://solscan.io/tx/5ZSozCHmAFmANaqyjRj614zxQY8HDXKyfAs2aAVjZaadS4DbDwVq8cTbxmM5m5VzDcfhysTSqZgKGV1j2A2Hqz1V
        return;
    }

    const accountsToBeFetched = new Array<PublicKey>();
    swapEvents.forEach((swapEvent) => {
        accountsToBeFetched.push(swapEvent.inputMint);
        accountsToBeFetched.push(swapEvent.outputMint);
    });

    if (feeEvent) {
        accountsToBeFetched.push(feeEvent.account);
    }

    await getUSDPriceForTokens(accountsToBeFetched.map(pk => pk.toString()).join(','))

    const swapData = parseSwapEvents(accountInfosMap, swapEvents);
    const instructions = parser.getInstructions(tx);
    const [initialPositions, finalPositions] =
        parser.getInitialAndFinalSwapPositions(instructions);

    const inSymbol = null; // We don't longer support this.
    const inMint = swapData[initialPositions[0]].inMint;
    const inSwapData = swapData.filter(
        (swap, index) => initialPositions.includes(index) && swap.inMint === inMint
    );
    const inAmount = inSwapData.reduce((acc, curr) => {
        return acc + BigInt(curr.inAmount);
    }, BigInt(0));
    const inAmountInDecimal = inSwapData.reduce((acc, curr) => {
        return acc.add(curr.inAmountInDecimal ?? 0);
    }, new Decimal(0));
    const inAmountInUSD = inSwapData.reduce((acc, curr) => {
        return acc.add(curr.inAmountInUSD ?? 0);
    }, new Decimal(0));

    const outSymbol = null; // We don't longer support this.
    const outMint = swapData[finalPositions[0]].outMint;
    const outSwapData = swapData.filter(
        (swap, index) => finalPositions.includes(index) && swap.outMint === outMint
    );
    const outAmount = outSwapData.reduce((acc, curr) => {
        return acc + BigInt(curr.outAmount);
    }, BigInt(0));
    const outAmountInDecimal = outSwapData.reduce((acc, curr) => {
        return acc.add(curr.outAmountInDecimal ?? 0);
    }, new Decimal(0));
    const outAmountInUSD = outSwapData.reduce((acc, curr) => {
        return acc.add(curr.outAmountInUSD ?? 0);
    }, new Decimal(0));

    const volumeInUSD =
        outAmountInUSD && inAmountInUSD
            ? Decimal.min(outAmountInUSD, inAmountInUSD)
            : outAmountInUSD ?? inAmountInUSD;

    const swap = {} as SwapAttributes;

    const [instructionName, transferAuthority, lastAccount] =
        parser.getInstructionNameAndTransferAuthorityAndLastAccount(instructions);

    swap.transferAuthority = transferAuthority;
    swap.lastAccount = lastAccount;
    swap.instruction = instructionName;
    swap.owner = tx.transaction.message.accountKeys[0].pubkey.toBase58();
    swap.programId = programId.toBase58();
    swap.signature = tx.transaction.signatures[0];
    swap.timestamp = new Date(start_time.getTime() - 3000)
    // swap.timestamp = new Date(new Date((blockTime ?? 0) * 1000).toISOString());
    swap.legCount = swapEvents.length;
    swap.volumeInUSD = volumeInUSD.toNumber();

    swap.inSymbol = inSymbol;
    swap.inAmount = inAmount;
    swap.inAmountInDecimal = inAmountInDecimal.toNumber();
    swap.inAmountInUSD = inAmountInUSD.toNumber();
    swap.inMint = inMint;

    swap.outSymbol = outSymbol;
    swap.outAmount = outAmount;
    swap.outAmountInDecimal = outAmountInDecimal.toNumber();
    swap.outAmountInUSD = outAmountInUSD.toNumber();
    swap.outMint = outMint;

    const exactOutAmount = parser.getExactOutAmount(
        tx.transaction.message.instructions
    );

    if (exactOutAmount) {
        swap.exactOutAmount = BigInt(exactOutAmount);

        if (outAmountInUSD) {
            swap.exactOutAmountInUSD = new Decimal(exactOutAmount)
                .div(outAmount.toString())
                .mul(outAmountInUSD)
                .toNumber();
        }
    }

    const exactInAmount = parser.getExactInAmount(
        tx.transaction.message.instructions
    );
    if (exactInAmount) {
        swap.exactInAmount = BigInt(exactInAmount);

        if (inAmountInUSD) {
            swap.exactInAmountInUSD = new Decimal(exactInAmount)
                .div(inAmount.toString())
                .mul(inAmountInUSD)
                .toNumber();
        }
    }

    swap.swapData = swapData;
    // swap.swapData = JSON.parse(JSON.stringify(swapData));
    console.log(feeEvent)

    // if (feeEvent) {
    //     console.log('accountInfo')
    //     console.log(accountInfosMap, accountsToBeFetched)
    //     console.log('fee event')
    //     console.log('------------------')
    //     console.log(feeEvent)
    //     console.log('----------------')
    //     const { mint, amount, amountInDecimal, amountInUSD } = extractVolume(
    //         accountInfosMap,
    //         feeEvent.mint,
    //         feeEvent.amount
    //     );
    //     swap.feeTokenPubkey = feeEvent.account.toBase58();
    //     swap.feeOwner = extractTokenAccountOwner(
    //         accountInfosMap,
    //         feeEvent.account
    //     )?.toBase58();
    //     swap.feeAmount = BigInt(amount);
    //     swap.feeAmountInDecimal = amountInDecimal?.toNumber();
    //     swap.feeAmountInUSD = amountInUSD?.toNumber();
    //     swap.feeMint = mint;
    // }

    // console.log(swap);
    await db_save_summary(swap);

    console.log(
        `Finished in ${(new Date().getTime() - start_time.getTime()) / 1000
        } seconds for transaction ${swap.signature}`
    )

    // return swap;
}

function parseSwapEvents(
    accountInfosMap: AccountInfoMap,
    swapEvents: SwapEvent[]
) {
    const swapData = swapEvents.map((swapEvent) => extractSwapData(accountInfosMap, swapEvent))

    return swapData;
}

function extractSwapData(
    accountInfosMap: AccountInfoMap,
    swapEvent: SwapEvent
) {
    const amm =
        AMM_TYPES[swapEvent.amm.toBase58()] ??
        `Unknown program ${swapEvent.amm.toBase58()}`;

    const {
        mint: inMint,
        amount: inAmount,
        amountInDecimal: inAmountInDecimal,
        amountInUSD: inAmountInUSD,
    } = extractVolume(
        accountInfosMap,
        swapEvent.inputMint,
        swapEvent.inputAmount
    );
    const {
        mint: outMint,
        amount: outAmount,
        amountInDecimal: outAmountInDecimal,
        amountInUSD: outAmountInUSD,
    } = extractVolume(
        accountInfosMap,
        swapEvent.outputMint,
        swapEvent.outputAmount
    );

    return {
        amm,
        inMint,
        inAmount,
        inAmountInDecimal,
        inAmountInUSD,
        outMint,
        outAmount,
        outAmountInDecimal,
        outAmountInUSD,
    };
}

function extractVolume(
    accountInfosMap: AccountInfoMap,
    mint: PublicKey,
    amount: BN
) {
    const tokenPriceInUSD = new Decimal(tokenUSDPrice[mint.toBase58()].price);
    // const tokenPriceInUSD = await getPriceInUSDByMint(mint.toBase58());
    const tokenDecimals = extractMintDecimals(accountInfosMap, mint);
    const amountInDecimal = DecimalUtil.fromBN(amount, tokenDecimals);
    const amountInUSD = tokenPriceInUSD
        ? amountInDecimal.mul(tokenPriceInUSD)
        : undefined;

    return {
        mint: mint.toBase58(),
        amount: amount.toString(),
        amountInDecimal,
        amountInUSD,
    };
}

function extractTokenAccountOwner(
    accountInfosMap: AccountInfoMap,
    account: PublicKey
): PublicKey {
    console.log(accountInfosMap, account.toBase58())
    const accountData = accountInfosMap.get(account.toBase58());

    return accountData ? new PublicKey(accountData.owner) : new PublicKey('');
}

function extractMintDecimals(accountInfosMap: AccountInfoMap, mint: PublicKey) {
    const mintData = accountInfosMap.get(mint.toBase58());

    return mintData ? mintData.uiTokenAmount.decimals : 0
}

// Initialize the WebSocket connection and set up event handlers
async function initializeWebSocket(): Promise<void> {
    // Test

    // const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=35eb685f-3541-4c70-a396-7aa18696c965'); // Use your own RPC endpoint here.
    // const tx = await connection.getParsedTransaction('5GZkharviv6BETxeU4HCAt4r9zRa6MUEtNnbZZW2xWkPkm113R1BozVHoJJqZoxERiuj9Kk8FnBqEnaf2x1ts2tR', {
    //   maxSupportedTransactionVersion: 0,
    // });

    // if (tx.meta.err) {
    //   console.log("Failed transaction", tx.meta.err);
    // }

    // parseTransaction(tx as TransactionWithMeta)
    // return;
    const ws = new WebSocket(
        'wss://atlas-mainnet.helius-rpc.com/?api-key=ca2cdbc8-39e0-483e-9514-7581edc3c44f'
    );

    ws.on('open', async () => {
        console.log('WebSocket is open');
        const filePath = 'sol_wallets.csv';

        const wallets = await fetchWalletAddresses();
        sendRequest(ws, wallets)
        startPing(ws)
        // console.log(wallets)
        // const dataList: string[] = [];

        // const readStream = fs.createReadStream(filePath);
        // const parser = csv.parse({ delimiter: ',', from_line: 2 });

        // parser.on('readable', () => {
        //     let record: string[] | null;
        //     while ((record = parser.read()) !== null) {
        //         dataList.push(record[0]);
        //     }
        // });

        // parser.on('end', () => {
        //     // sendRequest(ws, dataList);
        //     startPing(ws);
        // });

        // parser.on('error', (err: Error) => {
        //     console.error(err.message);
        // });

        // readStream.pipe(parser);
    });

    ws.on('message', (data: WebSocket.Data) => {
        const messageStr = data.toString('utf8');
        try {
            const messageObj: WebSocketMessage = JSON.parse(messageStr);
            if (!messageObj.params) return;
            const tx: TransactionWithMeta = messageObj.params.result?.transaction as TransactionWithMeta;
            if (tx) parseTransaction(tx);
        } catch (e) {
            console.error('Failed to parse JSON:', e);
        }
    });

    ws.on('error', (err: Error) => {
        console.error('WebSocket error:', err);
        console.log('WebSocket is restarting in 5 seconds');
        setTimeout(initializeWebSocket, 5000);
    });

    ws.on('close', () => {
        console.log('WebSocket is closed');
        console.log('WebSocket is restarting in 5 seconds');
        setTimeout(initializeWebSocket, 5000);
    });
}

const main = async () => {
    let timer_ws: NodeJS.Timeout | null = null;

    const connectWebSocket = () => {
        console.log("Connecting websocket");
        if (timer_ws) {
            clearTimeout(timer_ws);
        }
        timer_ws = setTimeout(connectWebSocket, 20 * 1000);

        const ws = new WebSocket(
            'wss://atlas-mainnet.helius-rpc.com/?api-key=ca2cdbc8-39e0-483e-9514-7581edc3c44f'
        );

        ws.on('open', async () => {
            console.log('WebSocket is open');
            const filePath = 'sol_wallets.csv';

            const wallets = await fetchWalletAddresses();
            sendRequest(ws, wallets)
            startPing(ws)
        });

        ws.on('message', (data: WebSocket.Data) => {
            const messageStr = data.toString('utf8');
            try {
                const messageObj: WebSocketMessage = JSON.parse(messageStr);
                if (!messageObj.params) return;
                const tx: TransactionWithMeta = messageObj.params.result?.transaction as TransactionWithMeta;
                if (tx) parseTransaction(tx);
            } catch (e) {
                console.error('Failed to parse JSON:', e);
            }
        });

        ws.on('error', (err: Error) => {
            console.error('WebSocket error:', err);
            console.log('WebSocket is restarting in 5 seconds');
            setTimeout(initializeWebSocket, 5000);
        });

        ws.on('close', () => {
            console.log('WebSocket is closed');
            console.log('WebSocket is restarting in 5 seconds');
            setTimeout(initializeWebSocket, 5000);
        });
    }

    await connectWebSocket();

    const server = http.createServer((req, res) => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain')
        res.end('Hello, World!\n')
    })

    const PORT = process.env.PORT || 3000
    server.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}/`)
    })

}

main()