# Showpad Backend Take-Home Test

A TypeScript + AWS Lambda + API Gateway + DynamoDB implementation of the requested throttling API.

## Assignment coverage

The supplied candidate document requires:

- `GET /foo`
- `GET /bar`
- `Authorization: Bearer <client-id>`
- Different rate-limiting algorithms for `/foo` and `/bar`
- `200 { "success": true }` while allowed
- `429 { "error": "rate limit exceeded" }` when throttled
- Configurable per-client limits
- At least two clients with different limits
- Two counter storage strategies: in-memory and persistent
- At least one automated test
- Cloud deployment as a stretch goal

This implementation also adds:

- TypeScript with strict mode
- AWS Lambda + API Gateway deployment
- DynamoDB persistence with TTL
- Atomic DynamoDB increments for the fixed-window counter
- `Retry-After`, `X-RateLimit-Limit`, and `X-RateLimit-Remaining` headers
- Unit tests for both algorithms and Authorization parsing
- 401/404/405/500 handling
- No-cache response headers
- Separation between authentication, algorithms, storage, configuration, and HTTP handling

## Architecture

```text
Client
  |
  | Authorization: Bearer client-1
  v
API Gateway
  |
  +--> GET /foo --> Lambda --> Token Bucket --> Memory OR DynamoDB
  |
  +--> GET /bar --> Lambda --> Fixed Window --> Memory OR DynamoDB
                                             |
                                             +--> DynamoDB TTL / atomic counter
```

### Why these algorithms?

### `/foo` - Token Bucket

Token Bucket allows a controlled burst up to the bucket capacity while refilling continuously.

For example, client-1 has a capacity of 5 and a refill rate of approximately 5 requests/minute. Five immediate requests can succeed; after the bucket is empty, requests are admitted again as tokens refill.

### `/bar` - Fixed Window

Fixed Window divides time into one-minute windows and counts requests in each window. It is intentionally different from Token Bucket and is simple to explain and operate.

One caveat is the classic fixed-window boundary burst: a client can use the full limit near the end of one window and again at the beginning of the next. A follow-up enhancement would be Sliding Window / GCRA if stricter smoothing is required.

## Storage strategies

### In-memory

`MemoryStore` uses a process-local JavaScript `Map`.

Good for:
- local development
- demonstrating the algorithm
- very simple deployments with one warm process

Important limitation:
- Lambda instances are independent.
- State can disappear on cold start.
- Multiple concurrent Lambda instances do not share the same Map.

Therefore this is intentionally a supported demonstration strategy, not the recommended production strategy for horizontally scaled AWS traffic.

### Persistent - DynamoDB

`DynamoDbStore` uses DynamoDB.

The `/bar` fixed-window counter uses an atomic `UpdateItem` operation, so concurrent requests do not perform an unsafe read-modify-write cycle.

DynamoDB TTL removes expired fixed-window records asynchronously. TTL is cleanup rather than the exact throttling boundary; the algorithm itself checks the current window.

For `/foo`, the token state is persisted as `tokens` and `lastRefillAtMs`.

For a production system with extremely high concurrency, a further enhancement would be to make token-bucket state updates atomic/conditional as well, or use a purpose-built distributed rate limiter. The current code keeps the storage interface simple and demonstrates the required persistent strategy.

## Client configuration

Default clients:

| Client | Limit | Window |
|---|---:|---:|
| client-1 | 5 | 60 sec |
| client-2 | 2 | 60 sec |

Configuration is environment-variable based:

```text
CLIENT_1_LIMIT
CLIENT_1_WINDOW_SECONDS
CLIENT_2_LIMIT
CLIENT_2_WINDOW_SECONDS
FOO_BUCKET_CAPACITY
FOO_REFILL_PER_SECOND
BAR_WINDOW_SECONDS
STORAGE_STRATEGY=memory|dynamodb
RATE_LIMIT_TABLE
```

## Prerequisites

- Node.js 20+
- npm
- AWS CLI
- AWS SAM CLI for AWS deployment

## Local setup

```bash
npm install
npm run build
npm test
```

For local memory storage:

```bash
set STORAGE_STRATEGY=memory
npm run build
sam local start-api
```

Linux/macOS:

```bash
STORAGE_STRATEGY=memory npm run build
sam local start-api
```

The local API is normally available at:

```text
http://127.0.0.1:3000
```

## Local curl demonstration

Client 1, `/foo`:

```bash
curl -i http://127.0.0.1:3000/foo \
  -H "Authorization: Bearer client-1"
```

Client 2, `/foo`:

```bash
curl -i http://127.0.0.1:3000/foo \
  -H "Authorization: Bearer client-2"
```

Client 1, `/bar`:

```bash
curl -i http://127.0.0.1:3000/bar \
  -H "Authorization: Bearer client-1"
```

Client 2, `/bar`:

```bash
curl -i http://127.0.0.1:3000/bar \
  -H "Authorization: Bearer client-2"
```

To demonstrate 429, call an endpoint repeatedly until its configured limit is exhausted.

Expected success body:

```json
{
  "success": true
}
```

Expected throttled body:

```json
{
  "error": "rate limit exceeded"
}
```

## AWS deployment

1. Configure AWS credentials:

```bash
aws configure
aws sts get-caller-identity
```

2. Build:

```bash
npm install
npm run build
```

3. Build the SAM application:

```bash
sam build
```

4. Deploy:

```bash
sam deploy --guided
```

Choose a stack name such as:

```text
showpad-rate-limit-api
```

Accept/create the required IAM role.

The template creates:

- API Gateway
- Lambda
- DynamoDB table
- Lambda IAM permission to access DynamoDB
- DynamoDB TTL configuration

After deployment, SAM prints `ApiBaseUrl`.

## Test the deployed API

If the output URL is:

```text
https://abc123.execute-api.eu-west-1.amazonaws.com/Prod
```

run:

```bash
curl -i "https://abc123.execute-api.eu-west-1.amazonaws.com/Prod/foo" \
  -H "Authorization: Bearer client-1"
```

and:

```bash
curl -i "https://abc123.execute-api.eu-west-1.amazonaws.com/Prod/bar" \
  -H "Authorization: Bearer client-2"
```

Repeat requests to show 429 behavior.

## Demonstration matrix

A reviewer can demonstrate all requested combinations:

| Endpoint | Algorithm | Client | Storage |
|---|---|---|---|
| `/foo` | Token Bucket | client-1 | Memory |
| `/foo` | Token Bucket | client-2 | Memory |
| `/bar` | Fixed Window | client-1 | Memory |
| `/bar` | Fixed Window | client-2 | Memory |
| `/foo` | Token Bucket | client-1 | DynamoDB |
| `/foo` | Token Bucket | client-2 | DynamoDB |
| `/bar` | Fixed Window | client-1 | DynamoDB |
| `/bar` | Fixed Window | client-2 | DynamoDB |

For AWS deployment, `template.yaml` defaults to DynamoDB because it is the horizontally shareable strategy.

To demonstrate memory mode in a deployed environment, change:

```yaml
STORAGE_STRATEGY: memory
```

and redeploy. For a fair take-home demonstration, use memory mode locally and DynamoDB mode in AWS.

## Design decisions to discuss in the interview

### 1. Why Authorization contains the client ID

The assignment explicitly defines:

```text
Authorization: Bearer <client-id>
```

The implementation therefore extracts the client ID from the Bearer token and uses it as part of the rate-limit key.

This is not a real authentication/identity system. In a production service, the token would normally be validated by an identity provider/JWT authorizer and the trusted client identity would come from the validated claims.

### 2. Rate-limit key isolation

Keys are scoped as:

```text
/foo:client-1
/bar:client-1
```

Therefore `/foo` and `/bar` do not consume each other's quotas, and different clients cannot consume the same counter.

### 3. Why DynamoDB

DynamoDB fits the AWS serverless architecture because it is managed, scales horizontally, supports low-latency key-value access, and provides conditional/atomic update capabilities.

### 4. Concurrency

The persistent fixed-window implementation uses atomic increment semantics.

The token bucket implementation is intentionally kept easy to understand. If the interview asks how to harden it for very high concurrency, discuss:
- conditional writes
- optimistic concurrency with a version number
- DynamoDB transactions where appropriate
- Redis/ElastiCache for high-frequency distributed rate limiting
- API Gateway/WAF managed throttling as an outer safety layer

### 5. Failure behavior

If DynamoDB is unavailable, the current handler returns HTTP 500 rather than silently bypassing throttling. This is a fail-closed security posture.

A production implementation should add:
- structured logging
- metrics
- tracing
- alarms
- retries with bounded backoff where appropriate
- a clear availability-vs-safety policy

## Security considerations

- Never log Authorization headers.
- In production, validate a real token/JWT rather than trusting a raw client ID.
- Use API Gateway authorizers where possible.
- Least-privilege IAM is used in the SAM template for the DynamoDB table.
- Do not expose DynamoDB directly to clients.
- Add AWS WAF/API Gateway throttling as defense in depth.
- Use HTTPS only in deployed environments.
- Validate configuration values at startup in a hardened production version.
- Consider abuse from very large client populations and key cardinality.

## Observability / production enhancements

Recommended next steps:

- CloudWatch structured JSON logs
- CloudWatch metrics for allowed/throttled requests
- dashboards and alarms
- AWS X-Ray tracing
- correlation/request IDs
- latency and DynamoDB error metrics
- rate-limit configuration in Parameter Store/AppConfig
- Secrets Manager if credentials/secrets are introduced
- API Gateway access logs
- infrastructure deployment through CI/CD

## Testing strategy

Included tests cover:

- Token Bucket allows configured burst
- Token Bucket returns throttled decision after capacity is exhausted
- Fixed Window allows requests up to limit
- Fixed Window rejects requests beyond limit
- Bearer Authorization parsing
- malformed/missing Authorization handling

Recommended additional tests:

- client isolation
- `/foo` vs `/bar` isolation
- window rollover
- token refill timing
- DynamoDB integration tests
- concurrent request tests
- handler-level HTTP contract tests
- AWS SAM/local integration tests

## Stretch ideas

If asked to extend the project during the interview:

1. Sliding Window / GCRA algorithm.
2. Per-client, per-endpoint configuration from DynamoDB.
3. Admin endpoint to change client limits.
4. JWT/OIDC authentication.
5. API Gateway Lambda authorizer.
6. CloudWatch dashboards and alarms.
7. OpenTelemetry/X-Ray tracing.
8. Terraform/CDK alternative IaC.
9. CI/CD with GitHub Actions.
10. Redis/ElastiCache implementation for high-throughput distributed counters.
11. Rate-limit response headers standardized around RFC-style conventions.
12. Integration and load tests.
13. Multi-region strategy.
14. Configuration versioning/auditing.

## Important implementation note

The assignment asks for "implement your own rate limiting logic". No framework/library is used to perform the rate limiting. The algorithms are implemented in `src/algorithms.ts`; storage is abstracted in `src/store.ts`.

## Cleanup

To delete the AWS stack:

```bash
sam delete
```

This removes the CloudFormation stack and its managed resources.
