# How you stop double-spending, and why you picked that approach.

- the requests run in 1 transactions and before running any logic we lock the user's wallet row so if two requests are processed concurrently the logic doesn't break
- after the lock we check for the duplicates
- we have also added the unique index on tx_id so even if the logic fails the database will still ensure the transaction is not processed twice
- this approach is simple and we can benefit from the features provided by database itself

# Which bugs you found in `credit`.

- no transactions
- float money (Number())
- wallet row is not locked so two concurrent updates can cause bug
- requests with same tx_id but different body is not handled
- throwing bad request exception which will cause the provider to keep tryin

# What happens if the database commits but the HTTP response is lost.

- It won't cause any issue even if the requests are retried as we have made sure that all requests are idempotent

# One thing you'd change before this went to production.

- add authentication

# Schema changes

- unique index on tx_id so each transaction applies only once
- partial index on ref_tx_id for refunds so each debit can be refunded only once
- if a refund arrives early then we save it with amount 0 so debit is cancelled
