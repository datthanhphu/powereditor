/**
* Copyright 2011 Facebook, Inc.
*
* You are hereby granted a non-exclusive, worldwide, royalty-free license to
* use, copy, modify, and distribute this software in source code or binary
* form for use in connection with the web services and APIs provided by
* Facebook.
*
* As with any software that integrates with the Facebook platform, your use
* of this software is subject to the Facebook Developer Principles and
* Policies [http://developers.facebook.com/policy/]. This copyright notice
* shall be included in all copies or substantial portions of the software.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
* THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
* FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
* DEALINGS IN THE SOFTWARE.
*
*
*/

var view  = require("../../uki-core/view"),
    utils = require("../../uki-core/utils"),
    env   = require("../../uki-core/env"),
    evt   = require("../../uki-core/event"),
    dom   = require("../../uki-core/dom"),
    build   = require("../../uki-core/builder").build,

    ParserJob = require("../job/tabSeparatedParser").Parser,
    CampImporterJob = require("../job/campImporter").Importer,
    AdImporterJob = require("../job/adImporter").Importer,
    LogDialog = require("../view/logDialog").LogDialog,

    Copy = require("./copy").Copy,
    App  = require("./app").App;



/**
* Handle Ad paste
* @namespace
*/
var Paste = {};

Paste.init = function() {
  // bind high level paste hanlder, so we can
  // support campaign and ad tab separated pastes
  var normalPasteCompletedBefore = false;

  evt.on(env.doc.body, 'paste', function(e) {
    var pasteView = targetView(e);
    if (pasteView) {
      normalPasteCompletedBefore = true;
      // read the data from clipboard
      var text = e.clipboardData.getData('text/plain') ||
          e.clipboardData.getData('text') || '';

      Paste.handler(pasteView, text);
    }
  });

  // FF only allows paste event on editable elements,
  // something that we cannot do here. So manually check
  // keydown event
  if (!env.ua.match(/Gecko\/\d+/)) {
    return;
  }
  evt.on(env.doc.body, 'keydown', function(e) {
    if (e.keyCode == 86 && (e.metaKey || e.ctrlKey)) {
      var pasteView = targetView(e);
      if (pasteView && !normalPasteCompletedBefore) {
        var activeElement = env.doc.activeElement;
        var dummy = copyDummy();
        dummy.value = '';
        dummy.focus();
        setTimeout(function() {
          var text = dummy.value;
          activeElement.focus();
          if (!normalPasteCompletedBefore) {
            Paste.handler(pasteView, text);
          }
        }, 10);
      }
    }
  }, true);
};

function targetView(e) {
  var v = view.closest(env.doc.activeElement);
  if (!v || !v.pasteTarget) {
      return false;
  }
  return v;
}

var _copyDummy = null;
function copyDummy() {
  if (!_copyDummy) {
    _copyDummy = dom.createElement('textarea', {
      style: 'position:absolute;left: -1000px'
    });
    env.doc.body.appendChild(_copyDummy);
  }
  return _copyDummy;
}

/**
* Event handler
*
* @param v the view that user pasted to
* @param text the text the user pasted
*/
Paste.handler = function(v, text) {
  // Windows tends to replace \n -> \r\n during copy
  text = text.replace(/(\r\n|\r|\n)/g, '\n').replace(/\r/g, '\n');

  var row = view.byId('campaignList-list').selectedRow();
  var account = row.account ? row.account() : row;

  Paste.resetDialog();
  require("../lib/completions").dialog = Paste.dialog();
  if (v.copySourceId && v.copySourceId() === 'campaigns') {
    Paste.pasteIntoCamps(account, text);
  } else {
    Paste.pasteIntoAds(account, text, view.byId('content').campaigns());
  }
};

// Error logging
// If no errors occurred dialog will remain hidden.
// When error appears during any process this dialog will show up with a line
// for that error. Dialog will grow with more errors being added.
// User can close dialog with 'Close' button
Paste.dialog = function() {
  return this._dialog ||
    (this._dialog = new LogDialog().title('Paste Progress'));
};

Paste.resetDialog = function() {
  if (this._dialog) { this._dialog.clear(); }
};

Paste.logError = function(error) {
  this.dialog().visible(true).log(error);
};

// Select campaign
// If user pastes from power editor and more than one campaign is selected
// (account is selected) ask which particular campaign user whants to use.
// Use selected ad as a hint to preselect campaign.
Paste.selectCampaignDialog = function() {
  if (!this._selectCampaignDialog) {
    this._selectCampaignDialog = build({ view: 'Dialog', childViews: [
      { view: 'DialogHeader', html: "Select target campaign" },
      { view: 'DialogContent', childViews: [
        { view: 'DialogBody', childViews: [
          { view: 'Text', text:
            'More then one campaign selected in the left panel. ' +
            'Please select the one you want to paste to.' },
          { view: 'Select', options: [], as: 'select' }
        ] },
        { view: 'DialogFooter', childViews: [
          { view: 'Button', label: 'OK', large: true, as: 'ok',
            use: 'confirm' },
          { view: 'Button', label: 'Close', large: true,
            on: { click: function() {
              Paste.selectCampaignDialog().visible(false);
          } } }
        ] }
      ] }
    ]});
  }
  return this._selectCampaignDialog;
};

Paste.selectCampaign = function(callback) {
  var selectedCampaigns = view.byId('content').campaigns();
  var selectedAd = view.byId('adPane-data').selectedRow();
  var dialog = Paste.selectCampaignDialog();
  dialog.view('select').options(selectedCampaigns.map(function(camp) {
    return { text: camp.name() + ' (' + camp.id() + ')', value: camp.id() };
  }));
  if (selectedAd) {
    dialog.view('select').value(selectedAd.campaign_id());
  }
  dialog.view('ok').removeListener('click').on('click', function() {
    dialog.visible(false);
    var id = dialog.view('select').value();
    for (var i = 0, l = selectedCampaigns.length; i < l; i++) {
      if (id === selectedCampaigns[i].id()) {
        callback([selectedCampaigns[i]]);
        return;
      }
    }
  });
  dialog.visible(true);
};

// Importing ads
Paste.pasteIntoAds = function(account, text, selectedCamps) {
  // C&P within App
  if (Copy.isInternalPaste(text, 'ads')) {
    if (selectedCamps.length > 1) {
      Paste.selectCampaign(function(filteredSelectedCamps) {
        Paste.pasteIntoAdsContinue(account, text, filteredSelectedCamps);
      });
    } else if (selectedCamps.length == 1) {
      Paste.pasteIntoAdsContinue(account, text, selectedCamps);
    }
  } else {
    Paste.pasteIntoAdsContinue(account, text, null);
  }
};

Paste.pasteIntoAdsContinue = function(account, text, selectedCamps) {
  var parser = new ParserJob(account, text);

  parser.excelPaste(!Copy.isInternalPaste(text, 'ads'));

  parser.oncomplete(function() {
    if (parser.errors().length) {
      alert(parser.errors()[0].message());
      return;
    }
    if (parser.foundAdProps().length < 2) {
      alert('Pasted text does not look like ads.');
      return;
    }
    if (parser.foundCampProps().length > 1) {
      Paste.logError('Pasted text contains campaign data. Ignoring.');
    }

    if (parser.ads().length) {
      var importer = new AdImporterJob(
        account,
        parser.ads(),
        utils.pluck(parser.foundAdProps(), 'name'));

      if (Copy.isInternalPaste(text, 'ads')) {
        // when copying within app, use selected campaign as a target
        // override any campaign_id previously selected
        parser.ads().forEach(function(ad) {
          ad
            .muteChanges(true)
            .id('')
            .campaign_id(selectedCamps[0].id())
            .muteChanges(false);
        });

        importer.useNameMatching(false);
      }

      importer
        .selectedCamps(selectedCamps)
        .onerror(function(e) { Paste.logError(e.error.message()); })
        .oncomplete(function() {
          view.byId('adPane').refreshAndSelect(importer.ads());
        })
        .start();
    } else {
      // nothing to paste
    }
  }).start();
};



// Importing campaigns
Paste.pasteIntoCamps = function(account, text) {
  var parser = new ParserJob(account, text);

  parser.excelPaste(!Copy.isInternalPaste(text, 'campaigns'));

  parser.oncomplete(function() {
    if (parser.errors().length) {
      alert(parser.errors()[0]);
      return;
    }
    if (parser.foundCampProps().length < 2) {
      alert('Pasted text does not look like campaign.');
      return;
    }

    if (parser.camps().length) {
      var importer = new CampImporterJob(
        account,
        parser.camps(),
        utils.pluck(parser.foundCampProps(), 'name'));

      if (Copy.isInternalPaste(text, 'campaigns')) {
        parser.camps().forEach(function(camp) {
          camp.id('');
        });
        importer.useNameMatching(false);
      }

      if (parser.ads().length && parser.foundAdProps().length > 2) {
        importer
          .ads(parser.ads())
          .adPropsToCopy(utils.pluck(parser.foundAdProps(), 'name'));
      }

      importer
        .onerror(function(e) { Paste.logError(e.error.message()); })
        .oncomplete(function() { App.reload(); }).start();
    } else {
      // nothing to paste
    }
  }).start();
};


exports.Paste = Paste;
