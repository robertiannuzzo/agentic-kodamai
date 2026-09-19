module Recruitment.Adapters.MockCV

import public Recruitment.Application.Ports

%default total

lookupText : (input : CVInput) -> List (CVInput, String) -> Either DomainError (CVText input)
lookupText _ [] = Left ExtractionFailed
lookupText input ((key, text) :: rest) =
  if input.locator == key.locator && input.version == key.version
     then Right (Extracted text)
     else lookupText input rest

export
mockExtractor : List (CVInput, String) -> Extractor
mockExtractor rows = MkExtractor (\input => lookupText input rows)

export
failingExtractor : Extractor
failingExtractor = mockExtractor []
