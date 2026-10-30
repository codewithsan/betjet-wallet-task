import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { WalletResponse } from './wallet/wallet.dto';

/**
 * The provider treats any non-200 status as a failure and retries it, so every
 * error (bad JSON, failed validation, unexpected bugs) becomes 200 INVALID_REQUEST.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Wallet');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    // Log so that real bugs aren't hidden behind INVALID_REQUEST.
    if (exception instanceof HttpException) {
      this.logger.warn(`${req.method} ${req.url}: ${JSON.stringify(exception.getResponse())}`);
    } else {
      this.logger.error(`${req.method} ${req.url}`, (exception as Error)?.stack);
    }

    const body: WalletResponse = { status: 'INVALID_REQUEST' };
    const txId = req.body?.txId;
    if (typeof txId === 'string') body.txId = txId;
    res.status(200).json(body);
  }
}
