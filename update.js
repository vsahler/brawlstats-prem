/* eslint no-console: ["error", { allow: ["log", "warn", "error"] }] */

require("dotenv").config({path: __dirname + "/.env"});

let dbname = "stats";

let mongodb = require("mongodb");
var MongoClient = mongodb.MongoClient;

var url = `mongodb://${process.env["DB_USER"]}:${process.env["DB_PWD"]}@${process.env["DB_IP"]}:${process.env["DB_PORT"]}/`;

function parseDate(str) {
    return new Date(Date.parse(`${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}T${str.slice(9, 11)}:${str.slice(11, 13)}:${str.slice(13, 15)}`));
}

function extractPlayer(obj) {
    let source = [];

    if("teams" in obj["battle"]) {
        obj["battle"]["teams"].forEach((team) => {
            team.forEach((player) => {source.push(player);});
        });
    }

    if("players" in obj["battle"]) {
        source = obj["battle"]["players"];
    }

    let ans = {};

    source.forEach((player) => {
        if(player.tag === process.env["PLAYER_TAG"]) {
            ans = player;
        }
    });

    return ans;
}

MongoClient.connect(url, function(err, db) {
    if (err) {
        console.log("Error : " + url + "\n" + err);
        process.exit(1);
    }

    let statsDB = db.db(dbname);
    let coll = statsDB.collection(dbname);

    coll.find({"epoch": null}).toArray().then((docs) => {
        docs.forEach((obj) => {
            coll.updateOne({"_id": new mongodb.ObjectId(obj["_id"])}, {$set: {epoch: parseDate(obj["battleTime"])}});
            console.log(`Updating ${obj["_id"]}`);
        });
    });

    coll.find({"extracted.player": null}).toArray().then((docs) => {
        docs.forEach((obj) => {
            coll.updateOne({"_id": new mongodb.ObjectId(obj["_id"])}, {$set: {"extracted.player": extractPlayer(obj)}});
            console.log(`Updating ${obj["_id"]}`);
        });
    });
});
