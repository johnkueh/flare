//! App-agnostic sync for a shared space (a household): a local SQLite
//! store of entries, one merge rule (at each entry path the newer write
//! wins, on a hybrid logical clock), field types read from entries, and a
//! sync engine that does no networking. The wire contract is
//! `PROTOCOL.md`; the server is `server/`.

pub mod hlc;
pub mod invite;
pub mod op;
pub mod position;
pub mod schema;
pub mod store;

pub use invite::{format_invite, invite_link, parse_invite};
pub use op::Op;
pub use position::position_between;
pub use schema::{FieldKind, Schema};
pub use store::{Change, PullOutcome, Store};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SyncError {
    #[error("database: {0}")]
    Db(String),
    #[error("invalid write: {0}")]
    InvalidOp(String),
    #[error("wrong field type: {0}")]
    WrongKind(String),
    #[error("schema: {0}")]
    Schema(String),
    #[error("unexpected server response: {0}")]
    BadResponse(String),
}
