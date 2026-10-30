import { Inject, Injectable, NotImplementedException } from "@nestjs/common";
import { DbService } from "../db.service";
import {
  CreditRequest,
  DebitRequest,
  RollbackRequest,
  WalletResponse,
} from "./wallet.dto";
import { PoolClient } from "pg";

const UNIQUE_VIOLATION = "23505";

@Injectable()
export class WalletService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async getBalance(userId: number): Promise<WalletResponse> {
    const res = await this.db.query(
      "SELECT balance FROM wallets WHERE user_id = $1",
      [userId],
    );
    if (!res.rowCount) return { status: "UNKNOWN_USER" };
    return { status: "OK", balance: res.rows[0].balance };
  }

  // TODO: implement (see README)
  async debit(_req: DebitRequest): Promise<WalletResponse> {
    throw new NotImplementedException("debit not implemented");
  }

  // Already "done" by a previous developer. Pays out a win.
  async credit(req: CreditRequest): Promise<WalletResponse> {
    try {
      return await this.db.withTransaction<WalletResponse>(async (client) => {
        // Lock the user's wallet row
        const wallet = await this.lockWallet(client, req.userId);
        if (!wallet) return { status: "UNKNOWN_USER", txId: req.txId };

        // Checking transaction already exists
        const existing = await client.query(
          `SELECT user_id = $2 AND type = 'casino_win' AND bet_id = $3 AND amount = $4::numeric AS same
             FROM wallet_transactions
            WHERE tx_id = $1`,
          [req.txId, req.userId, req.betId, req.amount],
        );

        if (existing.rowCount) {
          return existing.rows[0].same
            ? { status: "OK", txId: req.txId, balance: wallet.balance }
            : { status: "INVALID_REQUEST", txId: req.txId };
        }

        // Add the win
        const updated = await client.query(
          `UPDATE wallets SET balance = balance + $1, updated_at = now()
            WHERE user_id = $2
           RETURNING balance`,
          [req.amount, req.userId],
        );
        const balance: string = updated.rows[0].balance;

        // Write the ledger row
        await client.query(
          `INSERT INTO wallet_transactions (tx_id, user_id, bet_id, type, amount, balance_after)
           VALUES ($1, $2, $3, 'casino_win', $4, $5)`,
          [req.txId, req.userId, req.betId, req.amount, balance],
        );

        return { status: "OK", txId: req.txId, balance };
      });
    } catch (err) {
      // Same txId sent at the same moment for a different user.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        return { status: "INVALID_REQUEST", txId: req.txId };
      }
      throw err;
    }
  }

  // TODO: implement (see README)
  async rollback(_req: RollbackRequest): Promise<WalletResponse> {
    throw new NotImplementedException("rollback not implemented");
  }

  private async lockWallet(client: PoolClient, userId: number) {
    const res = await client.query(
      "SELECT balance, locked_exposure FROM wallets WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    return res.rows[0] as
      | { balance: string; locked_exposure: string }
      | undefined;
  }
}
