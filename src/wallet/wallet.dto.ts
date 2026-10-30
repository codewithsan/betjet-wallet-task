import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

// Rupees: 1-12 digits (NUMERIC(14,2) limit), optional 1-2 decimals, not zero.
const AMOUNT = /^(?!0+(\.0{1,2})?$)\d{1,12}(\.\d{1,2})?$/;

// JSON numbers become strings, so the amount is never handled as a float.
// A float error like 0.1 + 0.2 shows up as too many decimals and is rejected.
const toAmountString = ({ value }: { value: unknown }) =>
  typeof value === 'number' ? String(value) : value;

class BaseRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  txId!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647) // Postgres INT max
  userId!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  betId!: string;
}

export class DebitRequest extends BaseRequest {
  @Transform(toAmountString)
  @IsString()
  @Matches(AMOUNT)
  amount!: string; // rupees, up to 2 decimals
}

export class CreditRequest extends BaseRequest {
  @Transform(toAmountString)
  @IsString()
  @Matches(AMOUNT)
  amount!: string;
}

export class RollbackRequest extends BaseRequest {
  // txId is the id of this rollback call
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  refTxId!: string; // the debit to refund
}

export type WalletStatus =
  | 'OK'
  | 'INSUFFICIENT_FUNDS'
  | 'UNKNOWN_USER'
  | 'INVALID_REQUEST';

export interface WalletResponse {
  status: WalletStatus;
  txId?: string;
  balance?: string; // e.g. "100.00"
}
