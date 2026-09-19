module Recruitment.Application.Scoring

import public Recruitment.Application.Ports

%default total

||| A score and its audit evidence are one required result.
export
scoreWithEvidence : (a : Advert) -> Context -> Application a -> Either DomainError (Receipt a)
scoreWithEvidence a c app = do
  validContext c
  let req = requisitionOf a
  Right (MkReceipt (compute a app)
    (MkEvidence c req.reference req.revision
      ("advert:" ++ show (advertId a) ++ ";application:" ++ show (applicationId app) ++
       ";policy:" ++ policyVersion)))
