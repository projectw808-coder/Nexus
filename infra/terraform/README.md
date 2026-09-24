# Terraform skeleton (AWS)

Phase 0 ships the shape only. Nothing here is applied by CI.

- `main.tf` — provider + remote state placeholders.
- Planned modules (Phase 11): VPC, RDS Postgres 16 with pgvector, ElastiCache Redis 7, S3 bucket for
  attachments, KMS key for the TokenVault master key (`KMS_MASTER_KEY_ID`), ECS services for `web`
  and `worker`, an OTLP collector, SES or the configured `MailProvider`.
