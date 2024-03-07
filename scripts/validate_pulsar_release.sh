#!/bin/bash
# This script is used to validate a Pulsar release candidate
# It semi-automates the validation steps described in the Pulsar release process
# https://pulsar.apache.org/contribute/validate-release-candidate/
set -xe -o pipefail
VERSION=$1
CANDIDATE=${2:-"1"}
WORKING_DIR=$3

if [[ -z "$VERSION" ]]; then
    echo "Usage: $0 <version> <candidate> (<working_dir>)"
    exit 1
fi

if [[ -z "$WORKING_DIR" ]]; then
    WORKING_DIR=$(mktemp -d)
fi
echo "Working directory: $WORKING_DIR"
cd $WORKING_DIR

BASE_URL=https://dist.apache.org/repos/dist/dev/pulsar/pulsar-$VERSION-candidate-$CANDIDATE

# Download the release tarballs
for file in apache-pulsar-$VERSION-bin.tar.gz apache-pulsar-$VERSION-bin.tar.gz.asc \
 apache-pulsar-$VERSION-bin.tar.gz.sha512 apache-pulsar-$VERSION-src.tar.gz apache-pulsar-$VERSION-src.tar.gz.asc \
 apache-pulsar-$VERSION-src.tar.gz.sha512 connectors/pulsar-io-cassandra-$VERSION.nar; do
    wget -c $BASE_URL/$file
done

# Verify the release tarballs
gpg --verify apache-pulsar-$VERSION-bin.tar.gz.asc
gpg --verify apache-pulsar-$VERSION-src.tar.gz.asc

if [[ ! -d apache-pulsar-$VERSION ]]; then
    tar xvf apache-pulsar-$VERSION-bin.tar.gz
fi

if [[ ! -d apache-pulsar-$VERSION-src ]]; then
    tar xvf apache-pulsar-$VERSION-src.tar.gz
fi

if [[ ! -f apache-pulsar-$VERSION-src/build_ok ]]; then
    cd apache-pulsar-$VERSION-src
    mvn clean install -DskipTests
    touch build_ok
    cd ..
fi

if [[ ! -d apache-pulsar-$VERSION/connectors ]]; then
    mkdir apache-pulsar-$VERSION/connectors
    cp pulsar-io-cassandra-$VERSION.nar apache-pulsar-$VERSION/connectors
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
    echo "Retry with:"
    echo "rm -rf $WORKING_DIR/apache-pulsar-$VERSION"
    echo "$0" "$VERSION" "$CANDIDATE" "$WORKING_DIR"
    echo "Delete manually to clean up:"
    echo "rm -rf $WORKING_DIR"
}

cd apache-pulsar-$VERSION
sed -i.bak 's!statusFilePath=.*$!statusFilePath='"$PWD"'/status!' conf/standalone.conf && rm conf/standalone.conf.bak
touch status
PULSAR_STANDALONE_USE_ZOOKEEPER=1 bin/pulsar standalone &> standalone.log &
PULSAR_PID=$!
echo $PULSAR_PID > pulsar.pid
trap kill_processes EXIT

while ! grep -q "messaging service is ready" standalone.log; do
    echo "Waiting for Pulsar standalone to start"
    sleep 3
done

curl http://localhost:8080/status.html

grep "Found connector ConnectorDefinition(name=cassandra" standalone.log

nc -vz4 localhost 6650

echo "check function cluster"
curl -s http://localhost:8080/admin/v2/worker/cluster
echo ""
sleep 5

echo "check brokers"
curl -s http://localhost:8080/admin/v2/namespaces/public
echo ""
sleep 5

echo "check connectors"
curl -s http://localhost:8080/admin/v2/functions/connectors
echo ""
sleep 5


bin/pulsar-admin tenants create test
sleep 2
bin/pulsar-admin namespaces create test/test-namespace
sleep 2
bin/pulsar-admin functions create --function-config-file examples/example-function-config.yaml --jar examples/api-examples.jar

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


docker run -d --rm --name=cassandra$$ -p 9042:9042 cassandra:3.11
echo "Wait 10 seconds"
sleep 10
docker exec cassandra$$ nodetool status
docker exec -i cassandra$$ cqlsh localhost <<EOF
CREATE KEYSPACE pulsar_test_keyspace WITH replication = {'class':'SimpleStrategy', 'replication_factor':1};
USE pulsar_test_keyspace;
CREATE TABLE pulsar_test_table (key text PRIMARY KEY, col text);
EOF

cat > examples/cassandra-sink.yml <<EOF
configs:
    roots: "localhost:9042"
    keyspace: "pulsar_test_keyspace"
    columnFamily: "pulsar_test_table"
    keyname: "key"
    columnName: "col"
EOF

bin/pulsar-admin sink create --tenant public --namespace default --name cassandra-test-sink --sink-type cassandra --sink-config-file examples/cassandra-sink.yml --inputs test_cassandra
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

bin/pulsar-admin functions create --function-config-file examples/example-function-config.yaml --jar examples/api-examples.jar --name word_count --className org.apache.pulsar.functions.api.examples.WordCountFunction --inputs test_wordcount_src --output test_wordcount_dest

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
echo "All validation steps completed! (there are manual validation steps that are not automated)"

cat <<EOF
Vote for pulsar-$VERSION-candidate-$CANDIDATE with this email body:
====================

+1 (binding/non-binding)

- Built from source
- Checked the signatures of the source and binary release artifacts
- Run standalone
- Checked producer and consumer
- Verified the Cassandra connector
- Verified the Stateful function

====================
EOF