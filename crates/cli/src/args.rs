//! The command line, with clap doing the option splitting. Every option is accepted with every command; what clap
//! reports is put back into the CLI's own messages.
use crate::CliError;
use clap::error::{ContextKind, ContextValue, ErrorKind};
use clap::{CommandFactory, FromArgMatches, Parser};
use std::error::Error;
use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Help,
    Version,
    Serve,
    Open,
    Status,
    Refresh,
    Doctor,
    Login,
    Unlink,
    Uninstall,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Flags {
    pub json: bool,
    pub yes: bool,
    pub background: bool,
    pub data_dir: Option<PathBuf>,
    pub cloud_url: Option<String>,
    pub port: Option<u16>,
}

#[derive(Parser)]
#[command(
    name = "tokentracky",
    disable_help_flag = true,
    disable_version_flag = true,
    args_override_self = true
)]
struct Cli {
    command: Option<String>,
    #[arg(long)]
    json: bool,
    #[arg(short = 'y', long)]
    yes: bool,
    #[arg(long)]
    background: bool,
    #[arg(long, value_name = "dir")]
    data_dir: Option<PathBuf>,
    #[arg(long, value_name = "url")]
    cloud_url: Option<String>,
    #[arg(long, value_name = "port", value_parser = port, allow_negative_numbers = true)]
    port: Option<u16>,
    /// Not read as values: `parse` finds where `-h` and `-v` appeared.
    #[arg(short = 'h', long)]
    #[allow(dead_code)]
    help: bool,
    #[arg(short = 'v', long)]
    #[allow(dead_code)]
    version: bool,
}

enum Event {
    Flag(&'static str),
    Word(String),
}

/// `Number(text)` for the decimal forms, then the 0 to 65535 integer check.
fn port(text: &str) -> Result<u16, String> {
    let text = text.trim();
    let number = if text.is_empty() {
        0.0
    } else {
        text.parse::<f64>().unwrap_or(f64::NAN)
    };
    if number.fract() == 0.0 && (0.0..=65535.0).contains(&number) {
        Ok(number as u16)
    } else {
        Err("--port must be between 0 and 65535".into())
    }
}

/// The TypeScript text for what clap refused. Anything it does not know is clap's own first line.
fn message(error: &clap::Error) -> String {
    let argument = match error.get(ContextKind::InvalidArg) {
        Some(ContextValue::String(argument)) => argument.as_str(),
        _ => "",
    };
    let name = argument.split([' ', '=']).next().unwrap_or("");
    match error.kind() {
        ErrorKind::UnknownArgument if name.starts_with('-') => format!("Unknown option {name}"),
        ErrorKind::UnknownArgument => format!("Unexpected argument {argument}"),
        ErrorKind::InvalidValue => format!("{name} needs a value"),
        ErrorKind::ValueValidation => error.source().map(ToString::to_string).unwrap_or_default(),
        _ => {
            let text = error.to_string();
            text.lines()
                .next()
                .unwrap_or("")
                .trim_start_matches("error: ")
                .to_owned()
        }
    }
}

/// `argv` is the arguments after the program name. No command at all is `None`, which prints the usage and fails.
pub fn parse<I, T>(argv: I) -> Result<(Option<Command>, Flags), CliError>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let usage = |error: clap::Error| CliError::Usage(message(&error));
    let program = std::iter::once(OsString::from("tokentracky"));
    let matches = Cli::command()
        .try_get_matches_from(program.chain(argv.into_iter().map(Into::into)))
        .map_err(usage)?;
    let cli = Cli::from_arg_matches(&matches).map_err(usage)?;
    // There is one command word. `-h` and `-v` set it to `help` and `version`, replacing what came before; a word
    // after one of them is refused. That depends on the order of the arguments, so replay them in order.
    let flags = ["help", "version"]
        .into_iter()
        .filter(|&name| matches.get_flag(name))
        .flat_map(|name| {
            let at = matches.indices_of(name).into_iter().flatten();
            at.map(move |at| (at, Event::Flag(name))).collect::<Vec<_>>()
        });
    let word = cli.command.clone().zip(matches.index_of("command"));
    let mut events: Vec<_> = flags.chain(word.map(|(word, at)| (at, Event::Word(word)))).collect();
    events.sort_by_key(|(at, _)| *at);
    let mut word: Option<String> = None;
    for (_, event) in events {
        match event {
            Event::Flag(name) => word = Some(name.to_owned()),
            Event::Word(next) if word.is_none() => word = Some(next),
            Event::Word(next) => return Err(CliError::Usage(format!("Unexpected argument {next}"))),
        }
    }
    let command = match word.as_deref() {
        None => None,
        Some("help") => Some(Command::Help),
        Some("version") => Some(Command::Version),
        Some("serve") => Some(Command::Serve),
        Some("open") => Some(Command::Open),
        Some("status") => Some(Command::Status),
        Some("refresh") => Some(Command::Refresh),
        Some("doctor") => Some(Command::Doctor),
        Some("login") => Some(Command::Login),
        Some("unlink") => Some(Command::Unlink),
        Some("uninstall") => Some(Command::Uninstall),
        Some(other) => return Err(CliError::Usage(format!("Unknown command {other}"))),
    };
    let flags = Flags {
        json: cli.json,
        yes: cli.yes,
        background: cli.background,
        data_dir: cli.data_dir,
        cloud_url: cli.cloud_url,
        port: cli.port,
    };
    Ok((command, flags))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(argv: &[&str]) -> String {
        match parse(argv.iter().copied()) {
            Err(CliError::Usage(message)) => message,
            other => panic!("expected a usage error, got {other:?}"),
        }
    }

    #[test]
    fn reads_options_in_any_position_and_either_form() {
        let (command, flags) = parse(["--json", "status", "--data-dir=/tmp/x", "--port", "8080", "-y"]).unwrap();
        assert_eq!(command, Some(Command::Status));
        assert_eq!(
            flags,
            Flags {
                json: true,
                yes: true,
                background: false,
                data_dir: Some("/tmp/x".into()),
                cloud_url: None,
                port: Some(8080)
            }
        );
        assert_eq!(parse(["status", "-h"]).unwrap().0, Some(Command::Help));
        assert_eq!(parse(["-v"]).unwrap().0, Some(Command::Version));
        assert_eq!(parse(["help"]).unwrap().0, Some(Command::Help));
        assert_eq!(parse(["version"]).unwrap().0, Some(Command::Version));
        // The last of `-h`, `-v` and the command word before it wins; a word after one is refused.
        assert_eq!(parse(["-h", "-v"]).unwrap().0, Some(Command::Version));
        assert_eq!(parse(["-v", "-h"]).unwrap().0, Some(Command::Help));
        assert_eq!(usage(&["--help", "status"]), "Unexpected argument status");
        assert_eq!(parse(["--json"]).unwrap().0, None);
        assert_eq!(parse(["--port", " 0 "]).unwrap().1.port, Some(0));
    }

    #[test]
    fn puts_clap_refusals_into_the_typescript_messages() {
        assert_eq!(usage(&["launch"]), "Unknown command launch");
        assert_eq!(usage(&["status", "extra"]), "Unexpected argument extra");
        assert_eq!(usage(&["--nope"]), "Unknown option --nope");
        assert_eq!(usage(&["--nope=1"]), "Unknown option --nope");
        assert_eq!(usage(&["status", "--data-dir"]), "--data-dir needs a value");
        assert_eq!(usage(&["--cloud-url", "--json"]), "--cloud-url needs a value");
        for port in ["x", "65536", "-1", "1.5", "inf"] {
            assert_eq!(
                usage(&["status", "--port", port]),
                "--port must be between 0 and 65535",
                "{port}"
            );
        }
    }
}
