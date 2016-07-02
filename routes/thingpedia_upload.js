// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingPedia
//
// Copyright 2015 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details

const Q = require('q');
const express = require('express');
const passport = require('passport');
const multer = require('multer');
const csurf = require('csurf');
const JSZip = require('node-zip');
const ThingTalk = require('thingtalk');

var db = require('../util/db');
var code_storage = require('../util/code_storage');
var model = require('../model/device');
var schema = require('../model/schema');
var user = require('../util/user');
var expandExamples = require('../util/expand_examples');
var exampleModel = require('../model/example');

var router = express.Router();

router.use(multer().single('zipfile'));
router.use(csurf({ cookie: false }));

const DEFAULT_CODE = {"params": {"username": ["Username","text"],
                                 "password": ["Password","password"]},
                      "name": "Example Device of %s",
                      "description": "This is your Example Device",
                      "auth": {"type": "basic"},
                      "triggers": {
                          "source": {
                              "url": "https://www.example.com/api/1.0/poll",
                              "poll-interval": 300000,
                              "args": ["time", "measurement"],
                              "schema": ["Date", "Measure(m)"],
                              "doc": "report the latest measurement"
                          }
                      },
                      "actions": {
                          "setpower": {
                              "url": "http://www.example.com/api/1.0/post",
                              "args": ["power"],
                              "schema": ["Boolean"],
                              "doc": "power on/off the device"
                          }
                      },
                      "queries": {
                          "getpower": {
                              "url": "http://www.example.com/api/1.0/post",
                              "args": ["power"],
                              "schema": ["Boolean"],
                              "doc": "check if the device is on or off"
                          }
                     }
                    };
const DEFAULT_ONLINE_CODE = {"name": "Example Account of %s",
                             "description": "This is your Example Account",
                             "auth": {"type": "oauth2",
                                      "client_id": "your-oauth2-client-id",
                                      "client_secret": "your-oauth2-secret-encrypted-with-rot13",
                                      "authorize": "https://www.example.com/auth/2.0/authorize",
                                      "get_access_token": "https://www.example.com/auth/2.0/token",
                                      "get_profile": "https://www.example.com/api/1.0/profile",
                                      "profile": ["username"],
                                     },
                             "types": ["online-account"],
                             "global-name": "example",
                             "triggers": {
                                 "onmessage": {
                                     "url": "wss://www.example.com/api/1.0/data",
                                     "args": ["message"],
                                     "schema": ["String"],
                                     "doc": "trigger on each new message"
                                 }
                             },
                             "actions": {
                                 "post": {
                                     "url": "https://www.example.com/api/1.0/post",
                                     "args": ["message"],
                                     "schema": ["String"],
                                     "doc": "post a new message",
                                 }
                             },
                             "queries": {
                                "profile": {
                                     "url": "https://www.example.com/api/1.0/profile",
                                     "args": ["username", "pictureUrl", "realName", "link"],
                                     "schema": ["String", "Picture", "String", "String"],
                                     "doc": "read the user profile"
                                 },
                             }
                            };

router.get('/create', user.redirectLogIn, user.requireDeveloper(), function(req, res) {
    if (req.query.class && ['online', 'physical', 'data'].indexOf(req.query.class) < 0) {
        res.status(404).render('error', { page_title: "ThingPedia - Error",
                                          message: "Invalid device class" });
        return;
    }

    var online = req.query.class === 'online';

    var code = JSON.stringify(online ? DEFAULT_ONLINE_CODE : DEFAULT_CODE, undefined, 2);
    res.render('thingpedia_device_create_or_edit', { page_title: "ThingPedia - create new device",
                                                     csrfToken: req.csrfToken(),
                                                     device: { fullcode: true,
                                                               code: code },
                                                     create: true });
});

function schemaCompatible(s1, s2) {
    return s1.length >= s2.length &&
        s2.every(function(t, i) {
            var t1 = ThingTalk.Type.fromString(t);
            var t2 = ThingTalk.Type.fromString(s1[i]);
            try {
                ThingTalk.Type.typeUnify(t1, t2);
                return true;
            } catch(e) {
                return false;
            }
        });
}

function validateSchema(dbClient, type, ast, allowFailure) {
    return schema.getTypesByKinds(dbClient, [type]).then(function(rows) {
        if (rows.length < 1) {
            if (allowFailure)
                return;
            else
                throw new Error("Invalid device type " + type);
        }

        var types = rows[0].types;
        for (var trigger in types[0]) {
            if (!(trigger in ast.triggers))
                throw new Error('Type ' + type + ' requires trigger ' + trigger);
            if (!schemaCompatible(ast.triggers[trigger].schema, types[0][trigger]))
                throw new Error('Schema for ' + trigger + ' is not compatible with type ' + type);
        }
        for (var action in types[1]) {
            if (!(action in ast.actions))
                throw new Error('Type ' + type + ' requires action ' + action);
            if (!schemaCompatible(ast.actions[action].schema, types[1][action]))
                throw new Error('Schema for ' + action + ' is not compatible with type ' + type);
        }
        for (var query in (types[2] || {})) {
            if (!(query in ast.queries))
                throw new Error('Type ' + type + ' requires query ' + query);
            if (!schemaCompatible(ast.queries[query].schema, (types[2] || {})[query]))
                throw new Error('Schema for ' + query + ' is not compatible with type ' + type);
        }
    });
}

function validateDevice(dbClient, req) {
    var name = req.body.name;
    var description = req.body.description;
    var code = req.body.code;
    var kind = req.body.primary_kind;
    var fullcode = !req.body.fullcode;

    if (!name || !description || !code || !kind)
        throw new Error('Not all required fields were presents');

    var ast = JSON.parse(code);
    if (!ast.params)
        ast.params = {};
    if (!ast.types)
        ast.types = [];
    if (!ast.child_types)
        ast.child_types = [];
    if (!ast.auth)
        ast.auth = {"type":"none"};
    if (!ast.auth.type || ['none','oauth2','basic','builtin'].indexOf(ast.auth.type) == -1)
        throw new Error("Invalid auth type");
    if (fullcode && ast.auth.type === 'basic' && (!ast.params.username || !ast.params.password))
        throw new Error("Username and password must be provided for basic authentication");
    if (ast.types.indexOf('online-account') >= 0 && ast.types.indexOf('data-source') >= 0)
        throw new Error("Interface cannot be both marked online-account and data-source");

    if (!ast.triggers)
        ast.triggers = {};
    if (!ast.actions)
        ast.actions = {};
    if (!ast.queries)
        ast.queries = {};
    for (var name in ast.triggers) {
        if (!ast.triggers[name].schema)
            throw new Error("Missing trigger schema for " + name);
        if ((ast.triggers[name].args && ast.triggers[name].args.length !== ast.triggers[name].schema.length) ||
            (ast.triggers[name].params && ast.triggers[name].params.length !== ast.triggers[name].schema.length))
            throw new Error("Invalid number of arguments in " + name);
        if (ast.triggers[name].questions && ast.triggers[name].args.length !== ast.triggers[name].schema.length)
            throw new Error("Invalid number of questions in " + name);
        ast.triggers[name].schema.forEach(function(t) {
            ThingTalk.Type.fromString(t);
        });
    }
    for (var name in ast.actions) {
        if (!ast.actions[name].schema)
            throw new Error("Missing action schema for " + name);
        if ((ast.actions[name].args && ast.actions[name].args.length !== ast.actions[name].schema.length) ||
            (ast.actions[name].params && ast.actions[name].params.length !== ast.actions[name].schema.length))
            throw new Error("Invalid number of arguments in " + name);
        if (ast.actions[name].questions && ast.actions[name].questions.length !== ast.actions[name].schema.length)
            throw new Error("Invalid number of questions in " + name);
        ast.actions[name].schema.forEach(function(t) {
            ThingTalk.Type.fromString(t);
        });
    }
    for (var name in ast.queries) {
        if (!ast.queries[name].schema)
            throw new Error("Missing query schema for " + name);
        if ((ast.queries[name].args && ast.queries[name].args.length !== ast.queries[name].schema.length) ||
            (ast.queries[name].params && ast.queries[name].params.length !== ast.queries[name].schema.length))
            throw new Error("Invalid number of arguments in " + name);
        if (ast.queries[name].questions && ast.queries[name].questions.length !== ast.queries[name].schema.length)
            throw new Error("Invalid number of questions in " + name);
        ast.queries[name].schema.forEach(function(t) {
            ThingTalk.Type.fromString(t);
        });
    }

    if (fullcode) {
        if (!ast.name)
            throw new Error("Missing name");
        if (!ast.description)
            throw new Error("Missing description");
        for (var name in ast.triggers) {
            if (!ast.triggers[name].url)
                throw new Error("Missing trigger url for " + name);
        }
        for (var name in ast.actions) {
            if (!ast.actions[name].url)
                throw new Error("Missing action url for " + name);
        }
        for (var name in ast.queries) {
            if (!ast.queries[name].url)
                throw new Error("Missing query url for " + name);
        }
    } else if (!kind.startsWith('org.thingpedia.builtin.')) {
        if (!req.file || !req.file.buffer || !req.file.buffer.length)
            throw new Error('Invalid zip file');
    }

    return Q.all(ast.types.map(function(type) {
        return validateSchema(dbClient, type, ast, type === ast['global-name']);
    })).then(function() {
        return ast;
    });
}

function ensurePrimarySchema(dbClient, kind, ast) {
    var triggers = {};
    var triggerMeta = {};
    var actions = {};
    var actionMeta = {};
    var queries = {};
    var queryMeta = {};

    function handleOne(ast, out, outMeta) {
        for (var name in ast) {
            out[name] = ast[name].schema;
            outMeta[name] = {
                doc: ast[name].doc,
                label: (ast[name].confirmation || ast[name].label),
                canonical: ast[name].canonical,
                args: ast[name].params || ast[name].args || [],
                questions: ast[name].questions || []
            };
        }
    }

    handleOne(ast.triggers, triggers, triggerMeta);
    handleOne(ast.actions, actions, actionMeta);
    handleOne(ast.queries, queries, queryMeta);

    var types = [triggers, actions, queries];
    var meta = [triggerMeta, actionMeta, queryMeta];

    return schema.getByKind(dbClient, kind).then(function(existing) {
        return schema.update(dbClient,
                             existing.id, { developer_version: existing.developer_version + 1,
                                            approved_version: existing.approved_version + 1},
                             types, meta);
    }).catch(function(e) {
        return schema.create(dbClient, { developer_version: 0,
                                         approved_version: 0,
                                         kind: kind },
                             types, meta);
    }).then(function() {
        if (!ast['global-name'])
            return;

        return schema.getByKind(dbClient, ast['global-name']).then(function(existing) {
            return schema.update(dbClient,
                                 existing.id, { developer_version: existing.developer_version + 1,
                                                approved_version: existing.approved_version + 1 },
                                 types, meta);
        }).catch(function(e) {
            return schema.create(dbClient, { developer_version: 0,
                                             approved_version: 0,
                                             kind: ast['global-name'] },
                                 types, meta);
        });
    });
}

function exampleToAction(kind, actionName, assignments, argtypes) {
    var args = [];

    for (var name in assignments) {
        var type = argtypes[name];
        if (type.isString)
            args.push({ name: name, type: 'String', value: assignments[name] });
        else if (type.isNumber)
            args.push({ name: name, type: 'Number', value: assignments[name] });
        else if (type.isMeasure)
            args.push({ name: name, type: 'Measure', value: assignments[name][0],
                        unit: assignments[name][1] });
        else if (type.isBoolean)
            args.push({ name: name, type: 'Bool', value: assignments[name] });
        else
            throw new TypeError();
    }

    return {
        action: { name: 'tt:' + kind + '.' + actionName,
                  args: args }
    }
}

function ensureExamples(dbClient, ast) {
    if (!ast['global-name'])
        return;

    function generateAllExamples(schemaId) {
        // only do actions for now
        var out = [];

        for (var name in ast.actions) {
            var fromChannel = ast.actions[name];
            if (!Array.isArray(fromChannel.examples))
                continue;

            var argtypes = {};
            var argnames = fromChannel.params || fromChannel.args || [];
            argnames.forEach(function(name, i) {
                argtypes[name] = ThingTalk.Type.fromString(fromChannel.schema[i]);
            });

            fromChannel.examples.forEach(function(ex) {
                var jsonAction = exampleToAction(ast['global-name'], name, {}, argtypes);
                out.push({ schema_id: schemaId, is_base: true, utterance: ex,
                           target_json: JSON.stringify(jsonAction) });
            });

            try {
                var expanded = expandExamples(fromChannel.examples, argtypes);
                expanded.forEach(function(ex) {
                    var jsonAction = exampleToAction(ast['global-name'], name, ex.assignments, argtypes);
                    out.push({ schema_id: schemaId, is_base: false, utterance: ex.utterance,
                               target_json: JSON.stringify(jsonAction) });
                });
            } catch(e) {
                console.log('Failed to expand examples: ' + e.message);
            }
        }

        return out;
    }

    return schema.getByKind(dbClient, ast['global-name']).then(function(existing) {
        return exampleModel.deleteBySchema(dbClient, existing.id).then(function() {
            var examples = generateAllExamples(existing.id);
            if (examples.length > 0)
                return exampleModel.createMany(dbClient, examples);
        });
    });
}

function doCreateOrUpdate(id, create, req, res) {
    var name = req.body.name;
    var description = req.body.description;
    var code = req.body.code;
    var fullcode = !req.body.fullcode;
    var kind = req.body.primary_kind;
    var approve = !!req.body.approve;
    var online = false;

    var gAst = undefined;

    Q.try(function() {
        return db.withTransaction(function(dbClient) {
            return Q.try(function() {
                return validateDevice(dbClient, req);
            }).catch(function(e) {
                console.error(e.stack);
                res.render('thingpedia_device_create_or_edit', { page_title:
                                                                 (create ?
                                                                  "ThingPedia - create new device" :
                                                                  "ThingPedia - edit device"),
                                                                 csrfToken: req.csrfToken(),
                                                                 error: e,
                                                                 id: id,
                                                                 device: { name: name,
                                                                           primary_kind: kind,
                                                                           description: description,
                                                                           code: code,
                                                                           fullcode: fullcode },
                                                                 create: create });
                return null;
            }).tap(function(ast) {
                if (ast === null)
                    return;

                return ensurePrimarySchema(dbClient, kind, ast);
            }).tap(function(ast) {
                if (ast === null)
                    return;

                return ensureExamples(dbClient, ast);
            }).then(function(ast) {
                if (ast === null)
                    return null;

                var extraKinds = ast.types;
                var extraChildKinds = ast.child_types;
                var globalName = ast['global-name'];
                if (!globalName)
                    globalName = null;
                online = extraKinds.indexOf('online-account') >= 0;

                var obj = {
                    primary_kind: kind,
                    global_name: globalName,
                    name: name,
                    description: description,
                    fullcode: fullcode,
                };
                var code = JSON.stringify(ast);
                gAst = ast;

                if (create) {
                    obj.owner = req.user.developer_org;
                    if (req.user.developer_status < user.DeveloperStatus.TRUSTED_DEVELOPER ||
                        !approve) {
                        obj.approved_version = null;
                        obj.developer_version = 0;
                    } else {
                        obj.approved_version = 0;
                        obj.developer_version = 0;
                    }
                    return model.create(dbClient, obj, extraKinds, extraChildKinds, code);
                } else {
                    return model.get(dbClient, id).then(function(old) {
                        if (old.owner !== req.user.developer_org &&
                            req.user.developer_status < user.DeveloperStatus.ADMIN)
                            throw new Error("Not Authorized");

                        obj.owner = old.owner;
                        obj.developer_version = old.developer_version + 1;
                        if (req.user.developer_status >= user.DeveloperStatus.TRUSTED_DEVELOPER &&
                            approve)
                            obj.approved_version = obj.developer_version;

                        return model.update(dbClient, id, obj, extraKinds, extraChildKinds, code);
                    });
                }
            }).then(function(obj) {
                if (obj === null)
                    return null;

                if (!obj.fullcode && !obj.primary_kind.startsWith('org.thingpedia.builtin.')) {
                    var zipFile = new JSZip(req.file.buffer, { checkCRC32: true });

                    var packageJson = zipFile.file('package.json');
                    if (!packageJson)
                        throw new Error('package.json missing from device zip file');

                    var parsed = JSON.parse(packageJson.asText());
                    if (!parsed.name || !parsed.main)
                        throw new Error('Invalid package.json');

                    parsed['thingpedia-version'] = obj.developer_version;
                    parsed['thingpedia-metadata'] = gAst;

                    // upload the file asynchronously to avoid blocking the request
                    setTimeout(function() {
                        zipFile.file('package.json', JSON.stringify(parsed));

                        code_storage.storeFile(zipFile.generate({compression: 'DEFLATE',
                                                                 type: 'nodebuffer',
                                                                 platform: 'UNIX'}),
                                               obj.primary_kind, obj.developer_version)
                            .catch(function(e) {
                                console.error('Failed to upload zip file to S3: ' + e);
                            }).done();
                    }, 0);
                }

                return obj.primary_kind;
            }).then(function(done) {
                if (done) {
                    if (online)
                        res.redirect('/thingpedia/devices/by-id/' + done);
                    else
                        res.redirect('/thingpedia/devices/by-id/' + done);
                }
            });
        });
    }).catch(function(e) {
        console.error(e.stack);
        res.status(400).render('error', { page_title: "ThingPedia - Error",
                                          message: e });
    }).done();
}

router.post('/create', user.requireLogIn, user.requireDeveloper(), function(req, res) {
    doCreateOrUpdate(undefined, true, req, res);
});

router.get('/update/:id', user.redirectLogIn, user.requireDeveloper(), function(req, res) {
    Q.try(function() {
        return db.withClient(function(dbClient) {
            return model.get(dbClient, req.params.id).then(function(d) {
                if (d.owner !== req.user.developer_org &&
                    req.user.developer < user.DeveloperStatus.ADMIN)
                    throw new Error("Not Authorized");

                return model.getDeveloperCode(dbClient, req.params.id).then(function(row) {
                    d.code = row.code;
                    return d;
                });
            }).then(function(d) {
                try {
                    code = JSON.stringify(JSON.parse(d.code), undefined, 2);
                } catch(e) {
                    code = d.code;
                }
                res.render('thingpedia_device_create_or_edit', { page_title: "ThingPedia - edit device",
                                                                 csrfToken: req.csrfToken(),
                                                                 id: req.params.id,
                                                                 device: { name: d.name,
                                                                           primary_kind: d.primary_kind,
                                                                           description: d.description,
                                                                           code: code,
                                                                           fullcode: d.fullcode },
                                                                 create: false });
            });
        });
    }).catch(function(e) {
        res.status(400).render('error', { page_title: "ThingPedia - Error",
                                          message: e });
    }).done();
});

router.post('/update/:id', user.requireLogIn, user.requireDeveloper(), function(req, res) {
    doCreateOrUpdate(req.params.id, false, req, res);
});

module.exports = router;
