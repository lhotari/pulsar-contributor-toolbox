#!/bin/bash
#
# This script validates a Pulsar release in a Docker container.
#
# Prerequisites:
# - Docker with docker-in-docker support
# - validate_pulsar_release.sh script in the same directory as this script
#
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
set -eu
set -o pipefail

imagename="pulsar_release_validation:1"
imageid=$(docker images -q $imagename 2> /dev/null)
if [[ -z "$imageid" ]]; then
  docker build --tag $imagename - <<'EOT'
FROM ubuntu:latest
ARG DEBIAN_FRONTEND=noninteractive
ENV HOME=/root
RUN /bin/bash <<'EOS'
set -eux
set -o pipefail
apt-get update
apt-get dist-upgrade -y
apt-get install -y curl zip unzip wget ca-certificates git gpg locales netcat-openbsd jq docker.io vim procps less netcat-openbsd dnsutils iputils-ping
locale-gen en_US.UTF-8
EOS
ENV SDKMAN_DIR=/usr/local/sdkman
RUN /bin/bash <<'EOS'
set -eux
set -o pipefail
curl -s "https://get.sdkman.io" | bash
echo "sdkman_auto_answer=true" >> "${SDKMAN_DIR}/etc/config"
EOS
RUN /bin/bash <<'EOS'
source "${SDKMAN_DIR}/bin/sdkman-init.sh"
sdk install java 17.0.14-amzn
cd "${SDKMAN_DIR}/candidates/java"
ln -s 17.0.14-amzn 17
sdk install java 21.0.6-amzn
cd "${SDKMAN_DIR}/candidates/java"
ln -s 21.0.6-amzn 21
sdk install maven
EOS
EOT
fi

cleanup_resources() {
    set +e
    if [[ -n "$DOCKER_NETWORK" ]]; then
        docker network rm $DOCKER_NETWORK && echo "Deleted $DOCKER_NETWORK"
    fi
}

DOCKER_NETWORK="pulsar_network$$"
docker network create $DOCKER_NETWORK || { echo "Error: Failed to create network $DOCKER_NETWORK" >&2; exit 1; }
trap cleanup_resources EXIT
additional_params=()
if [[ -f "$SCRIPT_DIR/validate_pulsar_release.sh" ]]; then
    additional_params+=("-v" "$SCRIPT_DIR/validate_pulsar_release.sh:/pulsar_validation/validate_pulsar_release.sh")
else
    echo "Error: validate_pulsar_release.sh script not found. It should be in the same directory $SCRIPT_DIR as this script." >&2
    exit 1
fi

set +e
WORKING_DIR=$(CHECK_PARAMS=1 $SCRIPT_DIR/validate_pulsar_release.sh "$@")
if [[ $? -ne 0 ]]; then
    echo "$WORKING_DIR"
    exit 1
fi
set -e
if [[ -z "$WORKING_DIR" ]]; then
    WORKING_DIR=$(mktemp -d)
    chmod 777 "$WORKING_DIR"
fi
additional_params+=("-v" "$WORKING_DIR:$WORKING_DIR" "-e" "WORKING_DIR=$WORKING_DIR")

docker run --privileged -v /var/run/docker.sock:/var/run/docker.sock \
  --rm "${additional_params[@]}" --network $DOCKER_NETWORK \
  -e DOCKER_NETWORK=$DOCKER_NETWORK $imagename \
  bash -c 'source "${SDKMAN_DIR}/bin/sdkman-init.sh" && /pulsar_validation/validate_pulsar_release.sh "$@"' bash "$@"
