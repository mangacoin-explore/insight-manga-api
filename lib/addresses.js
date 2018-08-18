'use strict';

var bitcore = require('mangacore-lib');
var async = require('async');
var TxController = require('./transactions');
var Common = require('./common');

var _ = require('lodash');

function AddressController(node) {
  this.node = node;
  this.txController = new TxController(node);
  this.common = new Common({log: this.node.log});
}

AddressController.prototype.show = function(req, res) {
  var self = this;
  var options = {
    noTxList: parseInt(req.query.noTxList)
  };

  if (req.query.from && req.query.to) {
    options.from = parseInt(req.query.from);
    options.to = parseInt(req.query.to);
  }

  this.getAddressSummary(req.addr, options, function(err, data) {
    if(err) {
      return self.common.handleErrors(err, res);
    }

    res.jsonp(data);
  });
};

AddressController.prototype.balance = function(req, res) {
  this.addressSummarySubQuery(req, res, 'balanceSat');
};

AddressController.prototype.totalReceived = function(req, res) {
  this.addressSummarySubQuery(req, res, 'totalReceivedSat');
};

AddressController.prototype.totalSent = function(req, res) {
  this.addressSummarySubQuery(req, res, 'totalSentSat');
};

AddressController.prototype.unconfirmedBalance = function(req, res) {
  this.addressSummarySubQuery(req, res, 'unconfirmedBalanceSat');
};

AddressController.prototype.addressSummarySubQuery = function(req, res, param) {
  var self = this;
  this.getAddressSummary(req.addr, {}, function(err, data) {
    if(err) {
      return self.common.handleErrors(err, res);
    }

    res.jsonp(data[param]);
  });
};

AddressController.prototype.getAddressSummary = function(address, options, callback) {

  this.node.getAddressSummary(address, options, function(err, summary) {
    if(err) {
      return callback(err);
    }

    var transformed = {
      addrStr: address,
      balance: summary.balance / 1e8,
      balanceSat: summary.balance,
      totalReceived: summary.totalReceived / 1e8,
      totalReceivedSat: summary.totalReceived,
      totalSent: summary.totalSpent / 1e8,
      totalSentSat: summary.totalSpent,
      unconfirmedBalance: summary.unconfirmedBalance / 1e8,
      unconfirmedBalanceSat: summary.unconfirmedBalance,
      unconfirmedTxApperances: summary.unconfirmedAppearances, // misspelling - ew
      txApperances: summary.appearances, // yuck
      transactions: summary.txids
    };

    callback(null, transformed);
  });
};

AddressController.prototype.checkAddr = function(req, res, next) {
  req.addr = req.params.addr;
  this.check(req, res, next, [req.addr]);
};

AddressController.prototype.checkAddrs = function(req, res, next) {
  var self = this;

  function makeArray(addrs) {
    if (_.isString(addrs)) {
      return addrs.split(',');
    }
    return addrs;
  }

  if (req.params.addr) {
    req.addr = req.params.addr;
    req.addrs = [req.addr];
  } else if(req.body.addrs) {
    req.addrs = makeArray(req.body.addrs);
  } else {
    req.addrs = makeArray(req.params.addrs);
  }

  if(!_.isArray(req.addrs) || _.compact(req.addrs).length < 1) {
    return this.common.handleErrors({
      message: 'Must include address',
      code: 1
    }, res);
  }

  for(var i = 0; i < req.addrs.length; i++) {
    try {
      var a = new bitcore.Address(req.addrs[i]);
    } catch(e) {
      return self.common.handleErrors({
        message: 'Invalid address: ' + e.message,
        code: 1
      }, res);
    }
  }

  next();
};

AddressController.prototype.utxo = function(req, res) {
  var self = this;

  this.node.getAddressUnspentOutputs(req.addr, {}, function(err, utxos) {
    if(err) {
      return self.common.handleErrors(err, res);
    } else if (!utxos.length) {
      return res.jsonp([]);
    }
    res.jsonp(utxos.map(self.transformUtxo.bind(self)));
  });
};

AddressController.prototype.transformUtxo = function(utxoArg) {
  var utxo = {
    address: utxoArg.address,
    txid: utxoArg.txid,
    vout: utxoArg.outputIndex,
    scriptPubKey: utxoArg.script,
    amount: utxoArg.satoshis / 1e8,
    satoshis: utxoArg.satoshis
  };
  if (utxoArg.height && utxoArg.height > 0) {
    utxo.height = utxoArg.height;
    utxo.confirmations = this.node.services.bitcoind.height - utxoArg.height + 1;
  } else {
    utxo.confirmations = 0;
  }
  if (utxoArg.timestamp) {
    utxo.ts = utxoArg.timestamp;
  }
  return utxo;
};

AddressController.prototype._getTransformOptions = function(req) {
  return {
    noAsm: parseInt(req.query.noAsm) ? true : false,
    noScriptSig: parseInt(req.query.noScriptSig) ? true : false,
    noSpent: parseInt(req.query.noSpent) ? true : false
  };
};

// this call could take a while to run depending on what addresses are used
// considering memory constraints,  we will streaming out the results for addresses
// not necessarily in the order we received them
AddressController.prototype.multiutxo = function(req, res) {

  var self = this;

  var addresses;

  if (_.isArray(req.addrs)) {
    addresses = _.uniq(req.addrs);
  } else {
    addresses = _.compact(req.addrs.split(','));
  }

  var addressesLeft = addresses.length;
  var startedWriting = false;
  var cache = [];

  res.write('[');

  var sep = ',';

  async.eachLimit(addresses, 4, function(addr, next) {

    self.node.getAddressUnspentOutputs(addr, {}, function(err, utxos) {

      if (err) {
        return next(err);
      }

      if (addressesLeft-- > 0 && utxos.length > 0 && startedWriting) {
        res.write(sep);
      }

      for(var i = 0; i < utxos.length; i++) {
        startedWriting = true;
        if (utxos.length - 1 === i) {
          sep = '';
        }
        utxos[i] = self.transformUtxo(utxos[i]);
        cache.push(utxos[i]);
        res.write(JSON.stringify(utxos[i]) + sep);
      }

      sep = ',';
      next();

    });

  }, function(err) {

      if (err) {
        return self.common.handleErrors(err, res);
      }

      res.write(']');
      res.end();
  });

};

AddressController.prototype.multitxs = function(req, res) {
  var self = this;

  var options = {
    from: parseInt(req.query.from) || parseInt(req.body.from) || 0
  };

  options.to = parseInt(req.query.to) || parseInt(req.body.to) || parseInt(options.from) + 10;

  self.node.getAddressHistory(req.addrs, options, function(err, result) {
    if(err) {
      return self.common.handleErrors(err, res);
    }

    var transformOptions = self._getTransformOptions(req);

    self.transformAddressHistoryForMultiTxs(result.items, transformOptions, function(err, items) {
      if (err) {
        return self.common.handleErrors(err, res);
      }
      res.jsonp({
        totalItems: result.totalCount,
        from: options.from,
        to: Math.min(options.to, result.totalCount),
        items: items
      });
    });

  });
};

AddressController.prototype.transformAddressHistoryForMultiTxs = function(txinfos, options, callback) {
  var self = this;

  var items = txinfos.map(function(txinfo) {
    return txinfo.tx;
  }).filter(function(value, index, self) {
    return self.indexOf(value) === index;
  });

  async.map(
    items,
    function(item, next) {
      self.txController.transformTransaction(item, options, next);
    },
    callback
  );
};



module.exports = AddressController;
