#!/bin/bash

## Integration tests for the NLP components (training, inference)

set -e
set -x
set -o pipefail

srcdir=`dirname $0`/..
srcdir=`realpath $srcdir`

DATABASE_URL="mysql://thingengine:thingengine@localhost/thingengine_test"
export DATABASE_URL
AES_SECRET_KEY=80bb23f93126074ba01410c8a2278c0c
export AES_SECRET_KEY
JWT_SIGNING_KEY="not so secret key"
export JWT_SIGNING_KEY
SECRET_KEY="not so secret key"
export SECRET_KEY

workdir=`mktemp -t -d almond-nlp-integration-XXXXXX`
workdir=`realpath $workdir`
on_error() {
    test -n "$inferpid" && kill $inferpid
    inferpid=
    wait

    cd $oldpwd
    rm -fr $workdir
    rm -f $srcdir/secret_config.js
}
trap on_error ERR INT TERM

oldpwd=`pwd`
cd $workdir

# remove stale config files
rm -f $srcdir/secret_config.js

mkdir -p $workdir/etc/config.d
export THINGENGINE_CONFIGDIR=$workdir/etc
NLP_PORT=${NLP_PORT:-8400}
TRAINING_PORT=${TRAINING_PORT:-8090}
cat > ${THINGENGINE_CONFIGDIR}/config.yaml <<EOF
NL_SERVER_URL: "http://127.0.0.1:${NLP_PORT}"
NL_SERVER_ADMIN_TOKEN: my-super-secret-admin-token
TRAINING_URL: "http://127.0.0.1:${TRAINING_PORT}"
FILE_STORAGE_BACKEND: local
CDN_HOST: /download
WITH_THINGPEDIA: external
WITH_LUINET: embedded
THINGPEDIA_URL: https://dev.almond.stanford.edu/thingpedia
ENABLE_PROMETHEUS: true
PROMETHEUS_ACCESS_TOKEN: my-prometheus-access-token
MS_SPEECH_SUBSCRIPTION_KEY: "${MS_SPEECH_SUBSCRIPTION_KEY}"
MS_SPEECH_SERVICE_REGION: westus2
SUPPORTED_LANGUAGES:
  - en-US
  - it-IT
  - zh-CN
  - es-ES
NL_MODELS:
- tag: org.thingpedia.models.default
  locale: en
  owner: 1
  model_url: ./models/org.thingpedia.models.default:en
  contextual: true
  use_exact: true
EOF

# set up download directories
mkdir -p $workdir/shared/download
for x in template-files/en ; do
    mkdir -p $workdir/shared/download/$x
done
mkdir -p $workdir/shared/cache
echo '{"tt:stock_id:goog": "fb80c6ac2685d4401806795765550abdce2aa906.png"}' > $workdir/shared/cache/index.json

# clean the database and bootstrap
${srcdir}/dist/main.js bootstrap --force

mkdir -p 'models/org.thingpedia.models.default:en'

wget --no-verbose -c https://almond-static.stanford.edu/test-data/models/genienlp-v0.6.0a2.tar.xz -O $srcdir/tests/embeddings/genienlp-v0.6.0a2.xz
tar xvf $srcdir/tests/embeddings/genienlp-v0.6.0a2.xz -C 'models/org.thingpedia.models.default:en'
sed -i 's/}/,"eval_src_languages":"en"}/' 'models/org.thingpedia.models.default:en/config.json'

mkdir -p 'exact'
wget --no-verbose -c https://almond-static.stanford.edu/test-data/exact.tsv -O exact/en.tsv
${srcdir}/dist/main.js compile-exact-btrie -o exact/en.btrie exact/en.tsv

${srcdir}/dist/main.js run-nlp --port $NLP_PORT &
inferpid=$!

# kick off a dummy request to the nlp server just to get it ready
sleep 5
curl "http://127.0.0.1:$NLP_PORT/en-US/query?q=hello" || true

# in interactive mode, sleep forever
# the developer will run the tests by hand
# and Ctrl+C
if test "$1" = "--interactive" ; then
    sleep 84600
else
    # sleep until the process is settled
    sleep 30

    ts-node $srcdir/tests/nlp
fi

kill $inferpid
inferpid=
wait

cd $oldpwd
rm -fr $workdir
rm -f $srcdir/secret_config.js
