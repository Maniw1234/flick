'use strict';
// How a transfer that didn't go ended, in words (the why main.js gives moving.js end()): one list for the window's
// Transfers (transfers.js) and the progress card on the screen (card.js), so the two always say the same.
// (why 'changed' of a row of several files: changedN, "them")
window.XF_WHY = {
  in: { canceled: 'Canceled', declined: 'Declined', timeout: 'Not accepted in time', space: 'Not enough space', save: 'Couldn’t be saved', stalled: 'Didn’t finish',
    unpaired: 'Not paired any more', quit: 'Flick was closed there' },
  out: { canceled: 'Canceled', declined: 'Not accepted', timeout: 'Not accepted in time', space: 'Not enough space there', save: 'Couldn’t be saved there',
    stalled: 'Didn’t finish', unreachable: 'Couldn’t reach it', unconfirmed: 'Sent, not confirmed', unpaired: 'Not paired any more', old: 'Flick there needs updating',
    quit: 'Flick was closed there', changed: 'Changed on this PC. Send it again.', changedN: 'Changed on this PC. Send them again.' },
};
