#!/bin/bash
# This script is used to validate a Pulsar release candidate
# It semi-automates the validation steps described in the Pulsar release process
# https://pulsar.apache.org/contribute/validate-release-candidate/
# Script supports Linux and MacOS
# Tested with MacOS with the following homebrew packages:
# brew install wget gnupg coreutils jq
# In Linux, you will need curl, jq, wget, netcat and gpg packages installed.
# Installing the packages for Ubuntu:
# sudo apt-get install wget gpg netcat-openbsd curl jq
# In addition, you will need to have a working docker installation, as well as maven (mvn) and Java installed
# Please check https://pulsar.apache.org/contribute/setup-buildtools/ for installing build tools.
#
# There's also another script that can run this script in a Docker container when docker-in-docker support is available.
# Please see https://github.com/lhotari/pulsar-contributor-toolbox/blob/master/scripts/validate_pulsar_release_in_docker.sh for details.
# In that case you won't have to install all the dependencies on the machine where you run the script.
#
RETRY_CMD="$0 $@"
COMPLETED=0

while [[ "$1" =~ ^- && ! "$1" == "--" ]]; do
    case "$1" in
        --local)
            LOCAL=true
            shift
            ;;
        --docker-network=*)
            DOCKER_NETWORK="${1#--docker-network=}"
            shift
            ;;
        --pulsar-image=*)
            PULSAR_IMAGE="${1#--pulsar-image=}"
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        *)
            break
            ;;
    esac
done
if [[ "$1" == '--' ]]; then shift; fi

if [[ ! $CHECK_PARAMS ]]; then
    # check if required commands are installed
    required_commands=("wget" "gpg" "nc" "curl" "jq" "mvn" "java" "docker")
    for cmd in "${required_commands[@]}"; do
        if ! command -v "$cmd" &> /dev/null; then
            echo "$cmd could not be found. Please install $cmd and retry." >&2
            if [[ "$OSTYPE" == "darwin"* ]]; then
                echo "Tested with MacOS and homebrew."
                echo "Go to https://brew.sh/ and install homebrew then run:"
                echo "brew install wget gnupg coreutils jq"
            elif [[ "$OSTYPE" == "linux"* ]]; then
                echo "Tested with Ubuntu with the following packages:"
                echo "sudo apt-get install wget gpg netcat-openbsd curl jq"
            else
                echo "Please install $cmd using your package manager"
            fi
            exit 1
        fi
    done
fi

set -e -o pipefail

if [[ ! $LOCAL ]]; then
    VERSION=$1
    CANDIDATE=${2:-"1"}
    WORKING_DIR_PARAM=$3

    if [[ -z "$VERSION" ]]; then
        echo "Usage: $(basename "$0") <version> <candidate> (<working_dir>)"
        exit 1
    fi

    if [[ $CHECK_PARAMS ]]; then
        echo "${WORKING_DIR}"
        exit 0
    fi

    if [[ -z "$WORKING_DIR" ]]; then
        if [[ -z "$WORKING_DIR_PARAM" ]]; then
            WORKING_DIR=$(mktemp -d)
            RETRY_CMD="${RETRY_CMD} ${WORKING_DIR}"
        else
            WORKING_DIR="${WORKING_DIR_PARAM}"
        fi
    elif [[ -z "$WORKING_DIR_PARAM" ]]; then
        # working dir passed in environment variable
        RETRY_CMD="${RETRY_CMD} ${WORKING_DIR}"
    fi

    set -x
    echo "Working directory: $WORKING_DIR"
    cd $WORKING_DIR

    BASE_URL=https://dist.apache.org/repos/dist/dev/pulsar/pulsar-$VERSION-candidate-$CANDIDATE

    # Download the release tarballs
    for file in apache-pulsar-$VERSION-bin.tar.gz apache-pulsar-$VERSION-bin.tar.gz.asc \
    apache-pulsar-$VERSION-bin.tar.gz.sha512 apache-pulsar-$VERSION-src.tar.gz apache-pulsar-$VERSION-src.tar.gz.asc \
    apache-pulsar-$VERSION-src.tar.gz.sha512; do
        wget --progress=bar:force:noscroll -c $BASE_URL/$file
    done

    for file in pulsar-io-cassandra-$VERSION.nar pulsar-io-cassandra-$VERSION.nar.asc \
    pulsar-io-cassandra-$VERSION.nar.sha512; do
        wget --progress=bar:force:noscroll -c $BASE_URL/connectors/$file
    done

    # Import the Pulsar KEYS
    gpg --import <(curl https://dist.apache.org/repos/dist/release/pulsar/KEYS)

    # Verify the release tarballs
    gpg --verify apache-pulsar-$VERSION-bin.tar.gz.asc
    sha512sum -c apache-pulsar-$VERSION-bin.tar.gz.sha512
    gpg --verify apache-pulsar-$VERSION-src.tar.gz.asc
    sha512sum -c apache-pulsar-$VERSION-src.tar.gz.sha512
    gpg --verify pulsar-io-cassandra-$VERSION.nar.asc
    cat pulsar-io-cassandra-$VERSION.nar.sha512 | sed 's/\.\/connectors\///' | sha512sum -c -

    if [[ -d apache-pulsar-$VERSION ]]; then
        rm -rf apache-pulsar-$VERSION
    fi

    tar xvf apache-pulsar-$VERSION-bin.tar.gz

    if [[ ! -d apache-pulsar-$VERSION-src ]]; then
        tar xvf apache-pulsar-$VERSION-src.tar.gz
    fi

    if [[ ! -f apache-pulsar-$VERSION-src/build_ok && ! $SKIP_BUILD ]]; then
        cd apache-pulsar-$VERSION-src
        mvn -B clean install -DskipTests
        touch build_ok
        cd ..
    fi

    if [[ ! -d apache-pulsar-$VERSION/connectors ]]; then
        mkdir apache-pulsar-$VERSION/connectors
        cp pulsar-io-cassandra-$VERSION.nar apache-pulsar-$VERSION/connectors
    fi

    cd apache-pulsar-$VERSION
else 
    DISTFILE=$1
    CASSANDRA_NAR_FILE=$2
    WORKING_DIR=${3:-"${WORKING_DIR}"}

    if [[ ! ( -f "$DISTFILE" && -f "$CASSANDRA_NAR_FILE" ) ]]; then
        echo "Usage: $(basename "$0") --local <apache-pulsar-*-bin.tar.gz> <pulsar-io-cassandra-*.nar> (<working_dir>)"
        exit 1
    fi

    if [[ $CHECK_PARAMS ]]; then
        echo "${WORKING_DIR}"
        exit 0
    fi

    if [[ -z "$WORKING_DIR" ]]; then
        WORKING_DIR=$(mktemp -d)
    fi

    set -x
    echo "Working directory: $WORKING_DIR"
    tar zvxf "$DISTFILE" -C "$WORKING_DIR"
    PULSAR_HOME=$(ls -d "$WORKING_DIR"/apache-pulsar-*)
    mkdir "$PULSAR_HOME"/connectors
    cp "$CASSANDRA_NAR_FILE" "$PULSAR_HOME"/connectors/
    cd "$PULSAR_HOME"
fi

kill_processes() {
    set +xe
    if [[ -n "$PULSAR_PID" ]]; then
        kill $PULSAR_PID || true
    fi
    if [[ -n "$PULSAR_CONSUMER_PID" ]]; then
        kill $PULSAR_CONSUMER_PID || true
    fi
    docker rm -f cassandra$$ || true
    if [[ ! $LOCAL ]]; then
        echo "In case of transient errors in validation, you can retry with this command without re-downloading and re-building the release artifacts:"
        echo "$RETRY_CMD"
    else
        echo "In case of transient errors in validation, you can retry with this command:"
        echo "rm -rf $WORKING_DIR"
        echo "$0" --local "$DISTFILE" "$CASSANDRA_NAR_FILE"
    fi
    echo "Delete working directory manually to clean up:"
    echo "rm -rf $WORKING_DIR"
    if [[ $COMPLETED -eq 0 ]]; then
        NAR_DIR="${TMPDIR:-"/tmp"}/pulsar-nar"
        if [[ -d "$NAR_DIR" ]]; then
            echo "Sometimes extracted Pulsar nar files get corrupted. If you get an error 'Cannot resolve type description for org.apache.pulsar.io.cassandra.CassandraStringSink', you can try to remove the nar extraction directory with this command:"
            echo "rm -rf $(readlink -f "$NAR_DIR")"
        fi
    fi
}

sed -i.bak 's!statusFilePath=.*$!statusFilePath='"$PWD"'/status!' conf/standalone.conf && rm conf/standalone.conf.bak
touch status
PULSAR_HOST=localhost
if [[ -z "$PULSAR_IMAGE" ]]; then
    PULSAR_STANDALONE_USE_ZOOKEEPER=1 bin/pulsar standalone &> standalone.log &
    PULSAR_PID=$!
    echo $PULSAR_PID > pulsar.pid
else
    if [[ -n "$DOCKER_NETWORK" ]]; then
        docker run --name pulsar --network ${DOCKER_NETWORK} --rm -e PULSAR_STANDALONE_USE_ZOOKEEPER=1 ${PULSAR_IMAGE} bin/pulsar standalone &> standalone.log &
        PULSAR_PID=$!
        echo $PULSAR_PID > pulsar.pid
        PULSAR_HOST=pulsar
        # Update the client.conf to use the pulsar host
        sed -i 's!localhost!pulsar!' conf/client.conf
    else
        docker run --name pulsar$$ --rm -e PULSAR_STANDALONE_USE_ZOOKEEPER=1 -p 6650:6650 -p 8080:8080 ${PULSAR_IMAGE} bin/pulsar standalone &> standalone.log &
        PULSAR_PID=$!
        echo $PULSAR_PID > pulsar.pid
    fi
fi
trap kill_processes EXIT

while ! grep -q "messaging service is ready" standalone.log; do
    echo "Waiting for Pulsar standalone to start"
    sleep 3
done

curl http://${PULSAR_HOST}:8080/status.html

grep "Found connector ConnectorDefinition(name=cassandra" standalone.log

nc -vz4 ${PULSAR_HOST} 6650

echo "check function cluster"
curl -s http://${PULSAR_HOST}:8080/admin/v2/worker/cluster
echo ""
sleep 5

echo "check brokers"
curl -s http://${PULSAR_HOST}:8080/admin/v2/namespaces/public
echo ""
sleep 5

echo "check connectors"
curl -s http://${PULSAR_HOST}:8080/admin/v2/functions/connectors
echo ""
sleep 5


bin/pulsar-admin tenants create test
sleep 2
bin/pulsar-admin namespaces create test/test-namespace
sleep 2
bin/pulsar-admin functions create --function-config-file $PWD/examples/example-function-config.yaml --jar $PWD/examples/api-examples.jar

echo "Wait 10 seconds"
sleep 10

bin/pulsar-admin functions get --tenant test --namespace test-namespace --name example

sleep 5

bin/pulsar-admin functions status --tenant test --namespace test-namespace --name example

sleep 5

bin/pulsar-client consume -s test-sub -n 0 test_result &> consume.log &
PULSAR_CONSUMER_PID=$!

sleep 5

bin/pulsar-client produce -m "test-messages-`date`" -n 10 test_src

sleep 5

cat consume.log
if [[ "$(grep "got message" consume.log | wc -l)" -ne 10 ]]; then
    echo "Failed to consume messages"
    exit 1
fi
sleep 5

CASSANDRA_HOST=localhost
if [[ -z "$DOCKER_NETWORK" ]]; then
    docker run -d --rm --name=cassandra$$ -p 9042:9042 cassandra:3.11
else
    docker run -d --rm --name=cassandra$$ --network ${DOCKER_NETWORK} cassandra:3.11
    CASSANDRA_HOST=cassandra$$
fi
echo "Wait 20 seconds"
sleep 20
docker exec cassandra$$ nodetool status
docker exec -i cassandra$$ cqlsh localhost <<EOF
CREATE KEYSPACE pulsar_test_keyspace WITH replication = {'class':'SimpleStrategy', 'replication_factor':1};
USE pulsar_test_keyspace;
CREATE TABLE pulsar_test_table (key text PRIMARY KEY, col text);
EOF

cat > examples/cassandra-sink.yml <<EOF
configs:
    roots: "${CASSANDRA_HOST}:9042"
    keyspace: "pulsar_test_keyspace"
    columnFamily: "pulsar_test_table"
    keyname: "key"
    columnName: "col"
EOF

bin/pulsar-admin sink create --tenant public --namespace default --name cassandra-test-sink --sink-type cassandra --sink-config-file $PWD/examples/cassandra-sink.yml --inputs test_cassandra
sleep 5
bin/pulsar-admin sink get --tenant public --namespace default --name cassandra-test-sink
sleep 5
bin/pulsar-admin sink status --tenant public --namespace default --name cassandra-test-sink

for i in {0..10}; do bin/pulsar-client produce -m "key-$i" -n 1 test_cassandra; done
sleep 5

bin/pulsar-admin sink status --tenant public --namespace default --name cassandra-test-sink

docker exec -i cassandra$$ cqlsh localhost > test_table.log <<EOF
use pulsar_test_keyspace;
select * from pulsar_test_table;
EOF
cat test_table.log
if [[ "$(grep "key-" test_table.log | wc -l)" -ne 11 ]]; then
    echo "Cassandra sink failed to write to Cassandra"
    exit 1
fi

bin/pulsar-admin sink delete --tenant public --namespace default --name cassandra-test-sink

sleep 5

bin/pulsar-admin functions create --function-config-file $PWD/examples/example-function-config.yaml --jar $PWD/examples/api-examples.jar --name word_count --className org.apache.pulsar.functions.api.examples.WordCountFunction --inputs test_wordcount_src --output test_wordcount_dest

sleep 5

bin/pulsar-admin functions get --tenant test --namespace test-namespace --name word_count

sleep 5

bin/pulsar-admin functions status --tenant test --namespace test-namespace --name word_count

sleep 5

bin/pulsar-client produce -m "hello" -n 10 test_wordcount_src

sleep 5

bin/pulsar-admin functions querystate --tenant test --namespace test-namespace --name word_count -k hello

sleep 5

bin/pulsar-client produce -m "hello" -n 10 test_wordcount_src

sleep 5

bin/pulsar-admin functions querystate --tenant test --namespace test-namespace --name word_count -k hello > word_count.json

if [[ "$(cat word_count.json | jq  -r .numberValue)" != "20" ]]; then
    cat word_count.json || true
    echo "Word count function failed"
    exit 1
fi

bin/pulsar-admin functions delete --tenant test --namespace test-namespace --name word_count

set +xe
COMPLETED=1
echo "All validation steps completed! (there are manual validation steps that are not automated)"

mvn --version

if [[ ! $LOCAL ]]; then
cat <<EOF
Vote for pulsar-$VERSION-candidate-$CANDIDATE with this email body:
====================

+1 (binding/non-binding)

$(
if [[ ! $SKIP_BUILD ]]; then
    echo "- Built from source"
fi
)
- Checked the signatures of the source and binary release artifacts
- Ran pulsar standalone
  - Checked producer and consumer
  - Verified the Cassandra connector
  - Verified the Stateful function

====================
EOF
fi
