module Recruitment.Adapters.Codec

import public Recruitment.Application.Ports
import Data.String
import Data.List

%default total

||| Versioned length-prefixed Unicode character fields. Transport is UTF-8 text;
||| lengths count Idris characters, NOT bytes. Delimiters inside values are safe.
frame : String -> String
frame s = show (length (unpack s)) ++ ":" ++ s ++ ","

answerFields : List (Nat, String) -> List String
answerFields = concatMap (\(key, answer) => [show key, answer])

yearFields : List (Nat, Nat) -> List String
yearFields = concatMap (\(key, years) => [show key, show years])

encodeText : RawApplication -> String
encodeText raw = concat (map frame
  (["recruitment-application-v1", show raw.identifier, raw.cv.locator, raw.cv.version,
    show (length raw.answers)] ++ answerFields raw.answers ++
    [show (length raw.years)] ++ yearFields raw.years))

natural : String -> Either DomainError Nat
natural str =
  if str == "" || length (unpack str) > 20 || not (all isDigit (unpack str))
    then Left InvalidEncoding
    else case the (Maybe Nat) (parsePositive str) of
      Nothing => Left InvalidEncoding
      Just n => if show n == str then Right n else Left InvalidEncoding

frames : Nat -> List Char -> Either DomainError (List String)
frames _ [] = Right []
frames Z _ = Left InvalidEncoding
frames (S fuel) chars = do
  let (digits, rest) = span isDigit chars
  n <- natural (pack digits)
  if n > 100000 then Left InvalidEncoding else Right ()
  case rest of
    ':' :: body =>
      let (value, suffix) = splitAt n body in
      if length value /= n then Left InvalidEncoding else
        case suffix of
          ',' :: tail => do
            more <- frames fuel tail
            Right (pack value :: more)
          _ => Left InvalidEncoding
    _ => Left InvalidEncoding

readPairs : Nat -> List String -> Either DomainError (List (Nat, String), List String)
readPairs Z rest = Right ([], rest)
readPairs (S n) (key :: value :: rest) = do
  ident <- natural key
  (more, tail) <- readPairs n rest
  Right ((ident, value) :: more, tail)
readPairs _ _ = Left InvalidEncoding

readYears : List (Nat, String) -> Either DomainError (List (Nat, Nat))
readYears [] = Right []
readYears ((key, value) :: rest) = do
  years <- natural value
  more <- readYears rest
  Right ((key, years) :: more)

unpackFields : List String -> Either DomainError RawApplication
unpackFields ("recruitment-application-v1" :: ident :: locator :: version :: count :: rest) = do
  key <- natural ident
  countA <- natural count
  (answers, remaining) <- readPairs countA rest
  case remaining of
    count :: rest => do
      countY <- natural count
      (years, tail) <- readPairs countY rest
      values <- readYears years
      if null tail then Right (MkRawApplication key (MkCVInput locator version) answers values)
        else Left InvalidEncoding
    _ => Left InvalidEncoding
unpackFields _ = Left InvalidEncoding

||| Decoding produces an untrusted DTO, never approval evidence or a typed score.
||| The intake boundary must validate it against the loaded immutable advert.
export
decode : String -> Either DomainError RawApplication
decode text = do
  let chars = unpack text
  if length chars > 100000 then Left InvalidEncoding else Right ()
  fields <- frames (length chars) chars
  unpackFields fields

||| Refuse values outside the wire limits instead of producing undecodable output.
export
encode : RawApplication -> Either DomainError String
encode raw = do
  let text = encodeText raw
  _ <- decode text
  Right text
