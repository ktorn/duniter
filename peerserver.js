var async     = require('async');
var util      = require('util');
var jpgp      = require('./app/lib/jpgp');
var openpgp   = require('openpgp');
var logger    = require('./app/lib/logger')('peerserver');
var HDCServer = require('./hdcserver');

function PeerServer (dbConf, overrideConf) {

  HDCServer.call(this, dbConf, overrideConf);

  var that = this;
  var queue = [];

  that.peerInited = false;

  this._read = function (size) {
  };

  this._write = function (obj, enc, done) {
    async.waterfall([
      async.apply(that.initServer.bind(that)),
      function (next){
        if (obj.pubkey) {
          // Pubkey
          async.waterfall([
            function (next){
              var PublicKey = that.conn.model('PublicKey');
              var pubkey = new PublicKey({ raw: obj.pubkey });
              pubkey.construct(function (err) {
                next(err, pubkey);
              });
            },
            function (pubkey, next){
              that.PublicKeyService.submitPubkey(pubkey, next);
            },
            function (pubkey, next){
              that.emit('pubkey', pubkey);
              next();
            },
          ], next);
        } else if (obj.amendment) {
          // Vote
          async.waterfall([
            function (next){
              that.VoteService.submit(obj, next);
            },
            function (am, vote, next){
              that.emit('vote', vote);
              next();
            },
          ], next);
        } else if (obj.recipient) {
          // Transaction
          async.waterfall([
            function (next){
              that.TransactionsService.processTx(obj, next);
            },
            function (tx, next){
              that.emit('transaction', tx);
              next();
            },
          ], next);
        } else if (obj.endpoints) {
          // Peer
          async.waterfall([
            function (next){
              that.PeeringService.submit(obj, obj.keyID, next);
            },
            function (peer, next){
              that.emit('peer', peer);
              next();
            },
          ], next);
        } else if (obj.forward) {
          // Forward
          async.waterfall([
            function (next){
              that.PeeringService.submitForward(obj, next);
            },
            function (fwd, next){
              that.emit('forward', fwd);
              next();
            },
          ], next);
        } else if (obj.status) {
          // Status
          async.waterfall([
            function (next){
              that.PeeringService.submitStatus(obj, next);
            },
            function (status, peer, wasStatus, next){
              that.emit('status', status);
              next();
            },
          ], next);
        } else if (obj.requiredTrusts) {
          // Status
          async.waterfall([
            function (next){
              that.WalletService.submit(obj, next);
            },
            function (wallet, next){
              that.emit('wallet', wallet);
              next();
            },
          ], next);
        } else {
          var err = 'Unknown document type';
          that.emit('error', Error(err));
          next(err);
        }
      },
    ], function (err) {
      if (err){
        logger.debug(err);
        
      }
      done();
    });
  };

  this._initServices = function(conn, done) {
    async.waterfall([
      function (next){
        that.KeyService          = require('./app/service/KeyService').get(conn);
        that.PublicKeyService    = require('./app/service/PublicKeyService').get(conn, that.conf, that.KeyService);
        that.ContractService     = require('./app/service/ContractService').get(conn, that.conf);
        that.StrategyService     = require('./app/service/StrategyService').get(conn, that.conf, that.ContractService);
        that.VoteService         = require('./app/service/VoteService').get(conn, that.StrategyService);
        that.PeeringService      = require('./app/service/PeeringService').get(conn, that.conf, that.PublicKeyService, that.ParametersService);
        that.TransactionsService = require('./app/service/TransactionsService').get(conn, that.MerkleService, that.PeeringService);
        that.WalletService       = require('./app/service/WalletService').get(conn);
        async.parallel({
          contract: function(callback){
            that.ContractService.load(callback);
          },
          peering: function(callback){
            that.PeeringService.load(callback);
          },
        }, function (err) {
          next(err);
        });
      },
      function (next){
        that.checkConfig(next);
      },
      function (next){
        that.createSignFunction(that.conf, next);
      }
    ], done);
  };

  this.initServer = function (done) {
    if (!that.peerInited) {
      that.peerInited = true;
      async.waterfall([
        function (next){
          that.connect(next);
        },
        function (next){
          that.initServices(next);
        },
        function (next){
          that.initPeer(that.conn, that.conf, next);
        },
      ], done);
    } else {
      done();
    }
  };

  this.checkConfig = function (done) {
    async.waterfall([
      function (next){
        that.checkPeeringConf(that.conf, next);
      }
    ], done);
  };

  this.checkPeeringConf = function (conf, done) {
    var errors = [];
    var privateKey = openpgp.key.readArmored(conf.pgpkey).keys[0];

    if (conf.pgppasswd == null) {
      conf.pgppasswd = "";
    }
    if (!privateKey) {
      errors.push('This node requires a private key to work.');
    }
    try {
      if(privateKey && !privateKey.decrypt(conf.pgppasswd)) {
        errors.push('Wrong private key password.');
      }
    } catch(ex) {
      errors.push('Not a valid private key, message was: "' + ex.message + '"');
    }
    if (!conf.currency) {
      errors.push('No currency name was given.');
    }
    if(!conf.ipv4 && !conf.ipv6){
      errors.push("No interface to listen to.");
    }
    if(!conf.remoteipv4 && !conf.remoteipv6){
      errors.push('No interface for remote contact.');
    }
    if (!conf.remoteport) {
      errors.push('No port for remote contact.');
    }
    done(errors[0]);
  };

  this.createSignFunction = function (conf, done) {
    async.waterfall([
      function (next) {
        if (conf.openpgpjs) {
          var pgp = jpgp();
          var privateKey = openpgp.key.readArmored(conf.pgpkey).keys[0];
          privateKey.decrypt(conf.pgppasswd);
          var signingFunc = async.apply(pgp.sign.bind(pgp.sign), privateKey);
          next(null, function (message, done) {
            jpgp().sign(message, privateKey, done);
          });
        } else {
          var asciiPrivateKey = conf.pgpkey;
          var keyring = '~/.gnupg/ucoin_' + that.PeeringService.cert.fingerprint;
          logger.debug("Keyring = %s", keyring);
          var gnupg = new (require('./app/lib/gnupg'))(asciiPrivateKey, conf.pgppasswd, that.PeeringService.cert.fingerprint, keyring);
          gnupg.init(function (err) {
            next(err, function (message, done) {
              gnupg.sign(message, done);
            });
          });
        }
      },
      function (signFunc, next){
        that.sign = signFunc;
        try{
          that.sign("some test\nwith line return", next);
        } catch(ex){
          next("Wrong private key password.");
        }
      },
    ], function (err) {
      done(err);
    });
  }

  this.initPeer = function (conn, conf, done) {
    async.waterfall([
      function (next){
        // Add selfkey as managed
        conn.model('Key').setManaged(that.PeeringService.cert.fingerprint, true, next);
      },
      function (next){
        logger.info('Storing self public key...');
        that.initPubkey(conn, conf, next);
      },
      function (next){
        logger.info('Storing self peer...');
        that.initPeeringEntry(conn, conf, next);
      },
      function (next){
        logger.info('Broadcasting UP/NEW signals...');
        that.PeeringService.sendUpSignal(next);
      },
      function (next){
        that.PeeringService.regularUpSignal(next);
      },
      function (next){
        logger.info('Updating forwards...');
        that.PeeringService.updateForwards(next);
      },
      function (next){
        next();
      },
    ], done);
  };

  this.initPubkey = function (conn, conf, done) {
    that._write({ pubkey: that.PeeringService.cert.raw }, '', function (err) {
      done();
    });
  };

  this.initPeeringEntry = function (conn, conf, done) {
    var Peer = conn.model('Peer');
    var currency = conf.currency;
    async.waterfall([
      function (next) {
        Peer.find({ fingerprint: that.PeeringService.cert.fingerprint }, next);
      },
      function (peers, next) {
        var p1 = new Peer({});
        if(peers.length != 0){
          p1 = peers[0];
        }
        var endpoint = 'BASIC_MERKLED_API';
        if (conf.remotehost) {
          endpoint += ' ' + conf.remotehost;
        }
        if (conf.remoteipv4) {
          endpoint += ' ' + conf.remoteipv4;
        }
        if (conf.remoteipv6) {
          endpoint += ' ' + conf.remoteipv6;
        }
        if (conf.remoteport) {
          endpoint += ' ' + conf.remoteport;
        }
        var p2 = new Peer({
          version: 1,
          currency: currency,
          fingerprint: that.PeeringService.cert.fingerprint,
          endpoints: [endpoint]
        });
        var raw1 = p1.getRaw().unix2dos();
        var raw2 = p2.getRaw().unix2dos();
        if (raw1 != raw2) {
          logger.debug('Generating server\'s peering entry...');
          async.waterfall([
            function (next){
              jpgp().sign(raw2, that.PeeringService.privateKey, next);
            },
            function (signature, next) {
              signature = signature.substring(signature.indexOf('-----BEGIN PGP SIGNATURE'));
              p2.signature = signature;
              that.PeeringService.submit(p2, that.PeeringService.cert.fingerprint, next);
            },
          ], function (err) {
            next(err);
          });
        } else {
          next();
        }
      },
      function (next){
        Peer.getTheOne(that.PeeringService.cert.fingerprint, next);
      },
      function (peer, next){
        // Set peer's statut to UP
        that.PeeringService.peer(peer);
        that.PeeringService.peer().status = 'UP';
        that.PeeringService.peer().save(function (err) {
          // Update it in memory
          that.PeeringService.addPeer(that.PeeringService.peer());
          next(err);
        });
      },
    ], done);
  };

  this._listenBMA = function (app) {
    this.listenPKS(app);
    this.listenHDC(app);
    this.listenNET(app);
  };

  this.listenNET = function (app) {
    var net = require('./app/controllers/network')(that, that.conf);
    app.get(    '/network/pubkey',                                net.pubkey);
    app.get(    '/network/peering',                               net.peer);
    app.get(    '/network/peering/peers',                         net.peersGet);
    app.post(   '/network/peering/peers',                         net.peersPost);
    app.get(    '/network/peering/peers/upstream',                net.upstreamAll);
    app.get(    '/network/peering/peers/upstream/:fingerprint',   net.upstreamKey);
    app.get(    '/network/peering/peers/downstream',              net.downstreamAll);
    app.get(    '/network/peering/peers/downstream/:fingerprint', net.downstreamKey);
    app.post(   '/network/peering/forward',                       net.forward);
    app.post(   '/network/peering/status',                        net.statusPOST);
    app.get(    '/network/wallet',                                net.walletGET);
    app.post(   '/network/wallet',                                net.walletPOST);
    app.get(    '/network/wallet/:fpr',                           net.walletFPR);
  }
}

util.inherits(PeerServer, HDCServer);

module.exports = PeerServer;
