terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # backend "s3" {}  # configured per environment
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

# Phase 11: module "network", module "database", module "cache", module "storage", module "kms",
# module "services". Kept empty on purpose — see README.md.
