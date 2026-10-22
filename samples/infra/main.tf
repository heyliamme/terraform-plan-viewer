variable "env" {
  type    = string
  default = "production"
}

resource "random_pet" "server" {
  length = 2
}

resource "random_password" "db" {
  length  = 16
  special = false
}

resource "time_static" "created" {}

resource "time_static" "rotated" {}

resource "terraform_data" "settings" {
  input = { env = var.env, replicas = 3, features = ["a", "b", "c"] }
  lifecycle {
    precondition {
      condition     = var.env != ""
      error_message = "env must be set"
    }
  }
}

resource "null_resource" "hook" {
  triggers = { version = "2" }
}

resource "null_resource" "cbd" {
  triggers = { version = "2" }
  lifecycle { create_before_destroy = true }
}

removed {
  from = null_resource.forgotten
  lifecycle { destroy = false }
}

resource "local_file" "config" {
  filename = "${path.module}/out/config.json"
  content  = jsonencode({ server = random_pet.server.id, env = var.env, created = time_static.created.rfc3339, tags = { team = "platform", tier = "api" } })
}

resource "local_file" "stamp" {
  filename = "${path.module}/out/stamp.txt"
  content  = time_static.rotated.rfc3339
}

resource "local_sensitive_file" "secret" {
  filename = "${path.module}/out/secret.txt"
  content  = random_password.db.result
}

resource "local_file" "notes" {
  for_each = { a = "alpha" }
  filename = "${path.module}/out/${each.key}.txt"
  content  = each.value
}

moved {
  from = random_pet.legacy
  to   = random_pet.renamed
}

resource "random_pet" "renamed" {
  length = 1
}

module "child" {
  source = "./modules/child"
  count  = 1
  index  = count.index
}

moved {
  from = module.old_name
  to   = module.new_name
}

module "new_name" {
  source = "./modules/child"
  index  = 9
}

import {
  to = local_file.imported
  id = "${path.module}/out/imported.txt"
}

resource "local_file" "imported" {
  filename = "${path.module}/out/imported.txt"
  content  = "imported content\n"
}

check "config_present" {
  data "local_file" "cfg" {
    filename = "${path.module}/out/config.json"
  }
  assert {
    condition     = length(data.local_file.cfg.content) > 0
    error_message = "config.json must not be empty"
  }
}

check "env_is_staging" {
  assert {
    condition     = var.env == "staging"
    error_message = "env is not staging"
  }
}

data "local_file" "stamp_read" {
  filename   = local_file.stamp.filename
  depends_on = [local_file.stamp]
}

output "server" {
  value = random_pet.server.id
}

output "password" {
  value     = random_password.db.result
  sensitive = true
}

output "config_path" {
  value = local_file.config.filename
}

output "rotated_at" {
  value = time_static.rotated.rfc3339
}

output "replicas" {
  value = 3
}
