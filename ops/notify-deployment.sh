#!/usr/bin/env bash
set -Eeuo pipefail

container_id="${1:?bot container id is required}"
image="${2:?immutable image is required}"
state_file="${DEPLOYMENT_NOTIFICATION_STATE_FILE:-.deployment-notification-image}"

if [[ -f "$state_file" ]] && [[ "$(cat "$state_file")" == "$image" ]]; then
  echo "Deployment notification already recorded for ${image}."
  exit 0
fi

if ! output="$(docker exec "$container_id" node src/deployment-notification.js)"; then
  printf '%s\n' "$output"
  echo "Deployment notification failed; healthy production remains active." >&2
  exit 1
fi
printf '%s\n' "$output"

if ! grep -Eq '"sent":[1-9][0-9]*' <<<"$output"; then
  echo "No eligible private deployment notification recipient was found."
  exit 0
fi

state_temp="${state_file}.write.$$"
trap 'rm -f "$state_temp"' EXIT
printf '%s\n' "$image" > "$state_temp"
chmod 600 "$state_temp"
mv -f "$state_temp" "$state_file"
trap - EXIT
echo "Deployment notification recorded for ${image}."
