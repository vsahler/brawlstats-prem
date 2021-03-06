require("dotenv").config({path: __dirname + "/.env"});
let fs = require("fs");

let mongodb = require("mongodb");
let MongoClient = mongodb.MongoClient;

let dbname = "stats";
let url = `mongodb://${process.env["DB_USER"]}:${process.env["DB_PWD"]}@${process.env["DB_IP"]}:${process.env["DB_PORT"]}/`;

let statsDB = null;
let coll = null;

let fastify = require("fastify")({
    ignoreTrailingSlash: true
});

fastify.register(require("point-of-view"), {
    engine: {
        ejs: require("ejs")
    }
});

fastify.register(require('fastify-cookie'), {
    secret: process.env["COOKIE_SECRET"],   // for cookies signature
    parseOptions: {}                        // options for parsing cookies
})

function secondLevel(obj, first, second, value) {
    if(!(first in obj)) {
        obj[first] = {};
    }

    obj[first][second] = value;

    return obj; // Optional as node.js object are pointers
}

function getGraphs() {
    return JSON.parse(fs.readFileSync("./graphs.json"));
}

function verifyCookie(req, res) {
    if(!("time" in req.cookies)) {
        req.cookies.time = "{\"startTime\": -1, \"stopTime\": -1}"; // set undefined values (-1 => undefined in this code)
        res.setCookie("time", "{\"startTime\": -1, \"stopTime\": -1}", {
            domain: "localhost",
            path: "/",
            signed: false
        })
    }

    if(!("brawlerSel" in req.cookies)) {
        req.cookies.brawlerSel = "[\"*\"]";
        res.setCookie("brawlerSel", "[\"*\"]", {
            domain: "localhost",
            path: "/",
            signed: false
        })
    }
}

fastify.get("/cookieTest", function (req, res) {
    verifyCookie(req, res);

    res.send("Ok").end(200);
});

fastify.get("/", function (req, res) {
    verifyCookie(req, res)

    let graphs = getGraphs();

    res.view("/templates/index.ejs", {graphs, time: req.cookies.time, brawlers: req.cookies.brawlerSel});
});

fastify.post("/api", async function (req, res) {
    // req.query
    let query = {};
    let flags = {};
    let limit = 0;
    let project = {};
    let sort = {"epoch": -1}; // Default : sort from newer to older
    let forced = false;

    let startEpoch = -1; // set to null
    let stopEpoch = -1;
    let brawlers = ["*"];

    if("start_time" in req.query) {
        let epoch = Number.parseInt(req.query["start_time"], 10);
        if(!isNaN(epoch)) {
            secondLevel(query, "epoch", "$gte", new Date(epoch));
            startEpoch = epoch;
        }
    }

    if("end_time" in req.query) {
        let epoch = Number.parseInt(req.query["end_time"], 10);
        if(!isNaN(epoch)) {
            secondLevel(query, "epoch", "$lte", new Date(epoch));
            stopEpoch = epoch;
        }
    }

    if("ranked" in req.query) {
        secondLevel(query, "battle.type", (req.query["ranked"] === "0" ? "$ne":"$eq"), "ranked");
    }

    if("need_player" in req.query) {
        secondLevel(query, "player", (req.query["need_player"] !== "0" ? "$ne":"$eq"), null);
    }

    if("brawler" in req.query) {
        query["extracted.player.brawler.name"] = {"$in": JSON.parse(req.query["brawler"])};
        brawlers = JSON.parse(req.query["brawler"])
    }

    if("mode" in req.query) {
        query["battle.mode"] = {"$in": JSON.parse(req.query["mode"])};
    }

    if("limit" in req.query) {
        limit = Number.parseInt(req.query["limit"], 10);
        limit = (isNaN(limit) ? 0:limit); // There sure do have a better way to do this but it works
    }

    if("project" in req.query) {
        project = JSON.parse(req.query["project"]);
    }

    if("sort" in req.query) {
        sort = JSON.parse(req.query["sort"]);
    }

    let ans = await coll.find(query).sort(sort).project(project).limit(limit).toArray();

    if(ans.length === 0) { // if no battle found, for illustration purpose, show the next one
        forced = true; // send flag of forced
        delete query.epoch["$lte"]; // delete end time of request
        ans = await coll.find(query).sort({"epoch": -1}).project(project).limit(1).toArray(); // force limit to 1
    }

    if(ans.length === 0) { // if no next one is found, take the last one
        forced = true; // send flag of forced
        query.epoch["$lte"] = query.epoch["$gte"];
        delete query.epoch["$gte"]; // delete end time of request
        ans = await coll.find(query).sort({"epoch": 1}).project(project).limit(1).toArray(); // force limit to 1
    }

    // setup cookies
    res.setCookie(
        "time",
        JSON.stringify({startTime: startEpoch, stopTime: stopEpoch}),
        {
            domain: "localhost",
            path: "/",
            signed: false
        });

    res.setCookie(
        "brawlerSel",
        JSON.stringify(brawlers),
        {
            domain: "localhost",
            path: "/",
            signed: false
        }
    )

    res.send({l: ans.length, query, flags, limit, ans, forced});
});

fastify.post("/graphs", function (req, res) {
    res.send(getGraphs());
});

fastify.post("/brawlers", async function (req, res) {
    let lastUser = await coll.find({"player": {"$ne": null}}).sort({"epoch": -1}).project({"player": 1}).limit(1).toArray();
    lastUser = lastUser[0].player;

    let brawlers = lastUser.brawlers;

    res.send(brawlers);
});

fastify.post("/ranks", async function (req, res) {
    let limit = 0;
    if("limit" in req.query) {
        limit = Number.parseInt(req.query["limit"], 10);
        limit = (isNaN(limit) ? 0:limit); // There sure do have a better way to do this but it works
    }

    // This counts how many solo game winned with specific rank
    let soloRank = await coll.aggregate([
        {
            '$match': {
                'battle.mode': {
                    '$eq': 'soloShowdown'
                }
            }
        }, {
            '$group': {
                '_id': {
                    'date': {
                        '$dateToString': {
                            'format': '%Y-%m-%d',
                            'date': '$epoch'
                        }
                    },
                    'rank': '$battle.rank'
                },
                'battleCount': {
                    '$sum': 1
                }
            }
        }, {
            '$sort': {
                '_id.date': -1,
                '_id.rank': 1
            }
        }, {
            '$addFields': {
                'rank': '$_id.rank',
                'date': '$_id.date'
            }
        }, {
            '$project': {
                '_id': 0
            }
        }
    ]).toArray();

    let soloStats = await coll.aggregate([
        {
            '$match': {
                'battle.mode': {
                    '$eq': 'soloShowdown'
                }
            }
        }, {
            '$group': {
                '_id': {
                    '$dateToString': {
                        'format': '%Y-%m-%d',
                        'date': '$epoch'
                    }
                },
                'averageRank': {
                    '$avg': '$battle.rank'
                },
                'totalTRChange': {
                    '$sum': '$battle.trophyChange'
                }
            }
        }
    ]).toArray();

    let dailyTRStats = await coll.aggregate([
        {
            '$group': {
                '_id': {
                    '$dateToString': {
                        'format': '%Y-%m-%d',
                        'date': '$epoch'
                    }
                },
                'totalTRChange': {
                    '$sum': '$battle.trophyChange'
                }
            }
        }
    ]).toArray();

    res.send({soloRank, soloStats, dailyTRStats});
});

fastify.post("/interval", async function (req, res) {
    let first = await coll.find({"epoch": {"$ne": null}}).sort({"epoch": -1}).project({"epoch": 1}).limit(1).toArray();
    let last =  await coll.find({"epoch": {"$ne": null}}).sort({"epoch": 1} ).project({"epoch": 1}).limit(1).toArray();

    res.send({start: new Date(last[0].epoch), end: new Date(first[0].epoch)})
});

MongoClient.connect(url, function(err, db) {
    if (err) {
        /* eslint no-console: ["error", { allow: ["warn", "error"] }] */
        console.log("Error : "+url+"\n" + err);
        process.exit(1);
    }

    statsDB = db.db(dbname);
    coll = statsDB.collection(dbname);

    fastify.listen(3000, "0.0.0.0", function (err, address) {
        if (err) {
            fastify.log.error(err);
            process.exit(1);
        }

        fastify.log.info(`server listening on ${address}`);
        /* eslint no-console: ["error", { allow: ["warn", "error"] }] */
        console.log(`server listening on ${address}`);
    });
});
