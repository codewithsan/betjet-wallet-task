import { Inject, Injectable } from "@nestjs/common";
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

  async debit(req: DebitRequest): Promise<WalletResponse> {
    try {
      return await this.db.withTransaction<WalletResponse>(async (client) => {
        // Lock the user's wallet row
        const wallet = await this.lockWallet(client, req.userId);
        if (!wallet) return { status: "UNKNOWN_USER", txId: req.txId };

        // Checking transaction already exists
        const existing = await client.query(
          `SELECT user_id = $2 AND type = 'casino_bet' AND bet_id = $3 AND amount = $4::numeric AS same
             FROM wallet_transactions
            WHERE tx_id = $1`,
          [req.txId, req.userId, req.betId, req.amount],
        );
        if (existing.rowCount) {
          return existing.rows[0].same
            ? { status: "OK", txId: req.txId, balance: wallet.balance }
            : { status: "INVALID_REQUEST", txId: req.txId };
        }

        // Was this bet already cancelled by a rollback that arrived first?
        const cancelled = await client.query(
          `SELECT 1 FROM wallet_transactions
            WHERE type = 'casino_bet_refund' AND ref_tx_id = $1 AND user_id = $2`,
          [req.txId, req.userId],
        );
        if (cancelled.rowCount) {
          return {
            status: "INVALID_REQUEST",
            txId: req.txId,
            balance: wallet.balance,
          };
        }

        // Take the stake, only if spendable money covers it
        const updated = await client.query(
          `UPDATE wallets SET balance = balance - $1::numeric, updated_at = now()
            WHERE user_id = $2 AND balance - locked_exposure >= $1::numeric
           RETURNING balance`,
          [req.amount, req.userId],
        );
        if (!updated.rowCount) {
          return {
            status: "INSUFFICIENT_FUNDS",
            txId: req.txId,
            balance: wallet.balance,
          };
        }
        const balance: string = updated.rows[0].balance;

        // Write the ledger row
        await client.query(
          `INSERT INTO wallet_transactions (tx_id, user_id, bet_id, type, amount, balance_after)
           VALUES ($1, $2, $3, 'casino_bet', $4, $5)`,
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

  async rollback(req: RollbackRequest): Promise<WalletResponse> {
    try {
      return await this.db.withTransaction<WalletResponse>(async (client) => {
        const wallet = await this.lockWallet(client, req.userId);
        if (!wallet) return { status: "UNKNOWN_USER", txId: req.txId };

        // Checking transaction already exists
        const existing = await client.query(
          `SELECT user_id = $2 AND type = 'casino_bet_refund' AND bet_id = $3 AND ref_tx_id = $4 AS same
             FROM wallet_transactions
            WHERE tx_id = $1`,
          [req.txId, req.userId, req.betId, req.refTxId],
        );

        if (existing.rowCount) {
          return existing.rows[0].same
            ? { status: "OK", txId: req.txId, balance: wallet.balance }
            : { status: "INVALID_REQUEST", txId: req.txId };
        }

        // Find the transaction being rolled back, by tx_id only, so that
        // "not found" really means we haven't received it yet.
        const ref = await client.query(
          `SELECT user_id, type, amount FROM wallet_transactions WHERE tx_id = $1`,
          [req.refTxId],
        );

        // Debit not received yet: refund nothing, but leave a 0-amount marker
        // so the debit is rejected if it arrives later.
        if (!ref.rowCount) {
          await client.query(
            `INSERT INTO wallet_transactions (tx_id, user_id, bet_id, type, amount, balance_after, ref_tx_id)
             VALUES ($1, $2, $3, 'casino_bet_refund', 0, $4, $5)`,
            [req.txId, req.userId, req.betId, wallet.balance, req.refTxId],
          );
          return { status: "OK", txId: req.txId, balance: wallet.balance };
        }

        // Only a debit, and only the same user's, can be refunded
        const debit = ref.rows[0];
        if (debit.type !== "casino_bet" || debit.user_id !== req.userId) {
          return {
            status: "INVALID_REQUEST",
            txId: req.txId,
            balance: wallet.balance,
          };
        }

        // Only once: has another rollback already refunded this debit?
        const refunded = await client.query(
          `SELECT 1 FROM wallet_transactions
            WHERE type = 'casino_bet_refund' AND ref_tx_id = $1`,
          [req.refTxId],
        );
        if (refunded.rowCount) {
          return {
            status: "INVALID_REQUEST",
            txId: req.txId,
            balance: wallet.balance,
          };
        }

        // Refund exactly what the debit took
        const updated = await client.query(
          `UPDATE wallets SET balance = balance + $1, updated_at = now()
            WHERE user_id = $2
           RETURNING balance`,
          [debit.amount, req.userId],
        );
        const balance: string = updated.rows[0].balance;

        // Write the ledger row
        await client.query(
          `INSERT INTO wallet_transactions (tx_id, user_id, bet_id, type, amount, balance_after, ref_tx_id)
           VALUES ($1, $2, $3, 'casino_bet_refund', $4, $5, $6)`,
          [req.txId, req.userId, req.betId, debit.amount, balance, req.refTxId],
        );
        return { status: "OK", txId: req.txId, balance };
      });
    } catch (err) {
      // Same txId for another user, or two rollbacks for the same debit at once.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        return { status: "INVALID_REQUEST", txId: req.txId };
      }
      throw err;
    }
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
