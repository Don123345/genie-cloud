#!/bin/bash

## Integration tests for the embedded Thingpedia
## (API, web pages)

set -e
set -x
set -o pipefail

srcdir='/opt/almond-cloud'
workdir='/home/almond-cloud'
export THINGENGINE_ROOTDIR=$workdir

cd $workdir

# clean the database
mysql -h mariadb -u root -ppassword -e "drop database if exists thingengine_test;"
mysql -h mariadb -u root -ppassword -e "create database if not exists thingengine_test;"

# bootstrap
${srcdir}/dist/main.js bootstrap --force

# load some more data into Thingpedia
eval $(ts-node $srcdir/tests/load_test_thingpedia.ts)

# login as bob
bob_cookie=$(ts-node $srcdir/tests/login.js bob 12345678)

COOKIE="${bob_cookie}" ts-node $srcdir/tests/test_thingpedia_api_tt1.js
COOKIE="${bob_cookie}" ts-node $srcdir/tests/test_thingpedia_api_v3.js

# login as root
root_cookie=$(ts-node $srcdir/tests/login.js root rootroot)

# run the automated link checker
# first without login
ts-node $srcdir/tests/linkcheck.js
# then as bob (developer)
COOKIE="${bob_cookie}" ts-node $srcdir/tests/linkcheck.js
# then as root (admin)
COOKIE="${root_cookie}" ts-node $srcdir/tests/linkcheck.js

# test the website by making HTTP requests directly
ts-node $srcdir/tests/website

# test the website in a browser
# export PATH="/home/almond-cloud/geckodriver:$PATH"
# SELENIUM_BROWSER=firefox ts-node $srcdir/tests/test_website_selenium.js

# Now tests that we can update the datasets
mkdir -p $workdir/training/jobs/{1,2,3} $workdir/exact

# make up a training job
${srcdir}/dist/main.js execute-sql-file /proc/self/fd/0 <<<"insert into training_jobs set id = 1, job_type ='update-dataset', language = 'en', all_devices = 1, status = 'started', task_index = 0, task_name = 'update-dataset', config = '{}'"

# now update the exact match dataset (which will be saved to mysql and ./exact)
node ${srcdir}/dist/main.js run-training-task -t update-dataset --job-id 1 --job-dir $workdir/training/jobs/1 --debug
# download
node ${srcdir}/dist/main.js download-dataset -l en --output exact.tsv

set +o pipefail
shuf exact.tsv | head

sha256sum exact.tsv ./exact/en.btrie
sha256sum -c <<EOF
a7b8fae5c92429d744bdb686c91a09638b8eb7822b79d790ef83b2ca33a84d7c  exact.tsv
cc16d0bcd900c92bd7613d13299b683109bc2f9b2162e10369619f3eacfadffd  ./exact/en.btrie
EOF
