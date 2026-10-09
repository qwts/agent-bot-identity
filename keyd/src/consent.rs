//! The owner's consent for owner operations, asked by keyd itself: the macOS
//! device-owner prompt (Touch ID, a watch, or the login password) with
//! keyd's own description of the action. Nothing the caller presents can
//! stand in for it, so a soul that reaches the owner socket still needs a
//! person at the Mac.
//!
//! The same prompt answers `owner/presence`, agent-bot's owner gate
//! (agent-bot-identity #416): Touch ID where the Mac has it, otherwise the
//! login password. It never needs an administrator account.

/// Why the owner was not asked or did not approve. `Unavailable` means no
/// one could be asked here (no GUI session, no login password set): a
/// caller may fall back to another proof. `Declined` is a person's answer
/// (cancel, failure, timeout), and no fallback may ask again.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    Declined(String),
    Unavailable(String),
}

impl From<Refusal> for String {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::Declined(message) | Refusal::Unavailable(message) => message,
        }
    }
}

pub trait Consent: Send + Sync {
    fn ask(&self, reason: &str) -> Result<(), Refusal>;
}

/// LAError codes that mean the prompt could not be shown at all.
#[cfg(target_os = "macos")]
fn unavailable_code(code: isize) -> bool {
    // notInteractive (no GUI session), passcodeNotSet (no login password).
    matches!(code, -1004 | -5)
}

#[cfg(target_os = "macos")]
pub struct DeviceOwner;

#[cfg(target_os = "macos")]
impl Consent for DeviceOwner {
    fn ask(&self, reason: &str) -> Result<(), Refusal> {
        use block2::RcBlock;
        use objc2::runtime::Bool;
        use objc2_foundation::{NSError, NSString};
        use objc2_local_authentication::{LAContext, LAPolicy};
        use std::sync::mpsc;
        use std::time::Duration;

        let (tx, rx) = mpsc::channel::<Result<(), Refusal>>();
        // SAFETY: LAContext is created and used on this thread; the reply
        // block is Send (it only sends on a channel).
        unsafe {
            let context = LAContext::new();
            if let Err(error) = context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication)
            {
                let code = error.code();
                let message = format!("the owner cannot be asked here ({code})");
                return Err(if unavailable_code(code) {
                    Refusal::Unavailable(message)
                } else {
                    Refusal::Declined(message)
                });
            }
            let reply = RcBlock::new(move |success: Bool, error: *mut NSError| {
                let outcome = if success.as_bool() {
                    Ok(())
                } else if error.is_null() {
                    Err(Refusal::Declined("the owner did not approve".to_owned()))
                } else {
                    let code = (*error).code();
                    let message = format!("the owner did not approve ({code})");
                    Err(if unavailable_code(code) {
                        Refusal::Unavailable(message)
                    } else {
                        Refusal::Declined(message)
                    })
                };
                let _ = tx.send(outcome);
            });
            context.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &NSString::from_str(reason),
                &reply,
            );
            rx.recv_timeout(Duration::from_secs(120))
                .unwrap_or_else(|_| {
                    Err(Refusal::Declined(
                        "the owner did not answer in time".to_owned(),
                    ))
                })
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::{Consent, Refusal};
    use std::sync::Mutex;

    /// Answers from a script and records what it was asked.
    pub struct Scripted {
        pub approve: bool,
        /// When set, nobody can be asked: every ask is `Unavailable`.
        pub unavailable: bool,
        pub asked: Mutex<Vec<String>>,
    }

    impl Scripted {
        pub fn new(approve: bool) -> Self {
            Self {
                approve,
                unavailable: false,
                asked: Mutex::default(),
            }
        }

        pub fn unavailable() -> Self {
            Self {
                approve: false,
                unavailable: true,
                asked: Mutex::default(),
            }
        }
    }

    impl Consent for Scripted {
        fn ask(&self, reason: &str) -> Result<(), Refusal> {
            if self.unavailable {
                return Err(Refusal::Unavailable(
                    "the owner cannot be asked here (-1004)".into(),
                ));
            }
            self.asked.lock().unwrap().push(reason.to_owned());
            if self.approve {
                Ok(())
            } else {
                Err(Refusal::Declined("the owner did not approve".into()))
            }
        }
    }

    /// Shared, so a test can read what keyd asked after handing it over.
    impl Consent for std::sync::Arc<Scripted> {
        fn ask(&self, reason: &str) -> Result<(), Refusal> {
            self.as_ref().ask(reason)
        }
    }
}
