variable "index" {
  type = number
}

resource "random_integer" "n" {
  min = 1
  max = 100
}

resource "null_resource" "worker" {
  count    = 2
  triggers = { idx = var.index }
}

output "n" {
  value = random_integer.n.result
}
