//! What Drive makes of stored files (design S7, slice D1): the makers, functions of a file's bytes alone ([`parse`]),
//! and what an image result is asked as ([`spec`]). The engine that queues them, runs them in the platform's confined
//! helper and keeps what they make is slice D2, which waits for that helper (the platform's slice P2).
// ponytail: only the tests call the makers until D2 lands; then this allowance goes.
#![cfg_attr(not(test), allow(dead_code))]

pub(crate) mod parse;
pub(crate) mod spec;
