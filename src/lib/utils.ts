import { BN } from "@coral-xyz/anchor";
import Decimal from "decimal.js";
import got from "got";

// Caches for Price API
const jupiterPrices: Map<string, any> = new Map();
const jupiterTTL: Map<string, number> = new Map();

export async function getPriceInUSDByMint(
    tokenMint: string
): Promise<Decimal | undefined> {
    try {
        let price = jupiterPrices.get(tokenMint);
        let ttl = jupiterTTL.get(tokenMint);

        // Cache for 60 seconds
        if (price && ttl && new Date().getTime() - ttl < 60 * 1000) {
            return new Decimal(price);
        }

        let payload = (await got
            .get(`https://api.jup.ag/price/v2?ids=${tokenMint}`)
            .json()) as any;

        if (payload.data[tokenMint]) {
            let price = payload.data[tokenMint].price;

            jupiterPrices.set(tokenMint, price);
            jupiterTTL.set(tokenMint, new Date().getTime());

            return new Decimal(price);
        }
    } catch (e) {
        console.log(`coin not found: ${tokenMint}`);
        return;
    }

    return;
}

export class DecimalUtil {
    public static fromBigInt(input: BigInt, shift = 0): Decimal {
        return new Decimal(input.toString()).div(new Decimal(10).pow(shift));
    }

    public static fromBN(input: BN, shift = 0): Decimal {
        return new Decimal(input.toString()).div(new Decimal(10).pow(shift));
    }
}
