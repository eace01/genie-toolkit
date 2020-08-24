// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2020 The Board of Trustees of the Leland Stanford Junior University
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Author: Silei Xu <silei@cs.stanford.edu>
"use strict";


const assert = require('assert');
const fs = require('fs');
const util = require('util');
const ThingTalk = require('thingtalk');
const crypto = require('crypto');

const StreamUtils = require('../../../lib/utils/stream-utils');

const { makeMetadata } = require('../lib/metadata');
const { cleanEnumValue } = require('./utils');

function hash(obj) {
    const str = JSON.stringify(obj);
    const hasher = crypto.createHash('sha1');
    hasher.update(str);
    return hasher.digest().toString('hex');
}

class Normalizer {
    constructor() {
        // metadata for each schema.org type
        this.meta = {};

        // the normalized file
        this.output = {};

        this.includeOrder = false;
        // keep track of incremental id for each entity type
        this.dbIncIds = {};

        this.entityMap = null;
    }

    async init(args) {
        const library = ThingTalk.Grammar.parse(await util.promisify(fs.readFile)(args.thingpedia, { encoding: 'utf8' }));
        assert(library.isLibrary && library.classes.length === 1);
        const classDef = library.classes[0];
        this._classDef = classDef;

        for (let fn in classDef.queries) {
            const fndef = classDef.queries[fn];
            this.meta[fn] = {
                extends: [],
                fields: makeMetadata('com.google.sgd', fndef.args.map((argname) => fndef.getArgument(argname)))
            };
        }

        for (let fn in classDef.actions) {
            const fndef = classDef.actions[fn];
            this.meta[fn] = {
                extends: [],
                fields: makeMetadata('com.google.sgd', fndef.args.map((argname) => fndef.getArgument(argname)))
            };
        }
        if (args.entity_map !== null)
            this.entityMap = JSON.parse(await util.promisify(fs.readFile)(args.entity_map), { encoding: 'utf8' });
        if (args.include_order)
            this.includeOrder = true;
    }

    _processField(fname, arg, value) {
        const expectedType = this.meta[fname].fields[arg];

        if (value === null || value === undefined) {
            if (expectedType.isArray)
                return [];
            else
                return null;
        }

        if (expectedType.isArray && !Array.isArray(value)) {
            value = [value];
        } else if (!expectedType.isArray && Array.isArray(value)) {
            console.error(`Unexpected array for ${arg}`);
            if (value.length === 0)
                return null;
            value = value[0];
        }

        assert.strictEqual(typeof value, 'string');
        if (typeof expectedType.type === 'string') {
            if (expectedType.type === 'tt:Currency') {
                if (/^\s*(?:[0-9]+|\.[0-9]+)\s+[a-zA-Z]+/.test(String(value))) {
                    const [, num, currency] = /^\s*(?:[0-9]+|\.[0-9]+)\s+[a-zA-Z]+/.exec(String(value));
                    return {value: num, code: currency.toLowerCase()};
                }
                return {value: parseFloat(value), code: 'usd'};
            } else if (expectedType.type === 'tt:Number') {
                return parseFloat(value);
            } else if (expectedType.type === 'tt:Duration') {
                return ThingTalk.Units.transformToBaseUnit(parseFloat(value), 'min');
            } else if (expectedType.type === 'tt:Measure') {
                if (arg === 'temperature')
                    return ThingTalk.Units.transformToBaseUnit(parseFloat(value), 'F');
                if (arg === 'wind')
                    return ThingTalk.Units.transformToBaseUnit(parseFloat(value), 'mph');
                throw new Error(`Not recognized measurement type`);
            } else if (expectedType.type.startsWith('tt:Enum(')) {
                const enumerands = expectedType.type.substring('tt:Enum('.length, expectedType.type.length - 1).split(/,/g);
                value = cleanEnumValue(value);
                if (value === undefined || value === 'Dontcare')
                    return null;
                if (!enumerands.includes(value)) {
                    console.error(`Expected enumerated value for ${arg}, got`, value);
                    return null;
                }
                return value;
            } else if (expectedType.type === 'tt:EntityLower') {
                return String(value).toLowerCase();
            } else {
                return String(value);
            }
        }

        if (typeof expectedType.type === 'object') {
            if (expectedType.type.latitude && expectedType.type.longitude) {
                return {
                    display: String(value),
                    latitude: null,
                    longitude: null
                };
            }
        }

        return String(value);
    }

    _processResult(fname, result, sortingKeys) {
        const hashId = 'https://thingpedia.stanford.edu/ns/uuid/sgd/' + hash(result);
        if (Object.keys(this.dbIncIds).includes(fname))
            this.dbIncIds[fname]++;
        else
            this.dbIncIds[fname] = 1;
        let dbIncId = this.dbIncIds[fname];

        if (hashId in this.output[fname])
            return;

        const processed = { '@id': hashId, '@type': fname };
        if (this.includeOrder) {
            processed['@db_inc_id'] = dbIncId;
            processed['@sorting_keys'] = sortingKeys;
        }
        let slots = this.entityMap === null ? Object.keys(this.meta[fname].fields) : this.entityMap[fname].slots;
        for (let arg of slots)
            processed[arg] = this._processField(fname, arg, result[arg]);
        this.output[fname][hashId] = processed;
    }

    async process(filename) {
        let input = JSON.parse(await util.promisify(fs.readFile)(filename), { encoding: 'utf8' });
        for (let dialog of input) {
            for (let turn of dialog.turns) {
                for (let frame of turn.frames) {
                    if (!('service_call' in frame))
                        continue;
                    // record which params were used to get this result, so we can
                    // reverse engineer the db ordering later
                    let sortingKeys = frame.service_call.parameters;
                    if (!('service_results' in frame) ||
                        (frame.service_results.length === 0 && !frame.actions.map((action) => action.act).includes('NOTIFY_FAILURE'))) // If it's an action failure, there will be no service_results, but we'll still want to record the entity
                        continue;

                    let fname = frame.service + '_' + frame.service_call.method;
                    if (this.entityMap !== null) {
                        for (let entity in this.entityMap) {
                            if (this.entityMap[entity].methods.includes(fname))
                                fname = entity;
                        }
                    }
                    if (!(fname in this.meta))
                        continue;

                    if (!(fname in this.output))
                        this.output[fname] = {};

                    for (let result of frame.service_results)
                        this._processResult(fname, result, sortingKeys);
                }
            }
        }
        // now we repeat this loop once again to collect two exceptions
        // that weren't collected in the first pass: entities that are provided
        // by the user, but then the user changes their mind at confirmation time,
        // and entities which are provided by the user but result in failed actions
        // (so we never get results for these entities and we need to check again)
        // Note that we don't want to immediately catch those, since the order might
        // get messed up. They'll also have missing information, so we first want to
        // try getting them through the normal route.
        for (let dialog of input) {
            let methodName;
            for (let turn of dialog.turns) {
                for (let frame of turn.frames) {
                    // method names are not included in OFFER frames, so we
                    // need to constantly keep track of the last mentioned
                    // method name
                    if (frame.state)
                        methodName = frame.state.active_intent;
                    let actNames = frame.actions.map((action) => action.act);
                    if (!actNames.includes('NOTIFY_FAILURE') &&
                        !actNames.includes('CONFIRM'))
                        continue;

                    if (frame.service_call)
                        methodName = frame.service_call.method;
                    let fname = frame.service + '_' + methodName;
                    if (this.entityMap !== null) {
                        for (let entity in this.entityMap) {
                            if (this.entityMap[entity].methods.includes(fname))
                                fname = entity;
                        }
                    }
                    if (!(fname in this.meta))
                        continue;

                    if (!(fname in this.output))
                        this.output[fname] = {};

                    if (frame.actions.map((action) => action.act).includes('NOTIFY_FAILURE'))
                        this._processResult(fname, frame.service_call.parameters, {'sortLast': null});
                    else { // it's CONFIRMs slots
                        let params = {};
                        for (let action of frame.actions) {
                            if (action.act === 'CONFIRM')
                                params[action.slot] = action.canonical_values[0];
                        }
                        console.error(params);
                        this._processResult(fname, params, {'sortLast': null});
                    }
                }
            }
        }
    }
}

module.exports = {
    initArgparse(subparsers) {
        const parser = subparsers.add_parser('sgd-normalize-data', {
            add_help: true,
            description: "Generate normalized data from dialogs to match their ThingTalk representation."
        });
        parser.add_argument('--data-output', {
            type: fs.createWriteStream
        });
        parser.add_argument('--meta-output', {
            type: fs.createWriteStream
        });
        parser.add_argument('--thingpedia', {
            required: true,
            help: 'Path to ThingTalk file containing class definitions.'
        });
        parser.addArgument('--entity-map', {
            required: false,
            help: 'Path to a JSON containing a map from entities to service methods.'
        });
        parser.addArgument('--include-order', {
            required: false,
            action: 'storeTrue',
            help: 'Include information for reconstruction of db ordering in the output.'
        });
        parser.addArgument('input_file', {
            nargs: '+',
            help: 'Input JSON+LD files to normalize. Multiple input files will be merged in one.'
        });
    },

    async execute(args) {
        const normalizer = new Normalizer();
        await normalizer.init(args);
        for (let filename of args.input_file)
            await normalizer.process(filename);

        if (args.meta_output) {
            args.meta_output.end(JSON.stringify(normalizer.meta, undefined, 2));
            await StreamUtils.waitFinish(args.meta_output);
        }

        if (args.data_output) {
            args.data_output.end(JSON.stringify(normalizer.output, undefined, 2));
            await StreamUtils.waitFinish(args.data_output);
        }
    }
};
