#!/bin/sh
set -eu

data_dir=/app/services/knowledge-ai/data
seed_dir=/app/services/knowledge-ai/data-seed

umask 077
mkdir -p "$data_dir" "$data_dir/images" "$data_dir/kb-docs" "$data_dir/backup"

copy_default() {
  source_file=$1
  target_file=$2
  if [ ! -e "$target_file" ]; then
    cp "$source_file" "$target_file"
  fi
}

copy_default "$seed_dir/model-config.template.json" "$data_dir/model-config.json"
copy_default "$seed_dir/annotation-config.template.json" "$data_dir/annotation-config.json"
copy_default "$seed_dir/field-defs.json" "$data_dir/field-defs.json"

exec "$@"
