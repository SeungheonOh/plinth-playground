module Plutarch.Browser (dumpScript) where

import Data.ByteString qualified as ByteString
import Data.Char (isAlphaNum)
import Data.Text qualified as Text
import Language.Haskell.TH.Syntax (Dec, Q, runIO)
import Plutarch.Script (Script (unScript))
import PlutusCore.Flat (flat)
import UntypedPlutusCore qualified as UPLC

-- | Export a compiled Plutarch script in the Flat format consumed by the
-- playground's decoder and CEK evaluator.
dumpScript :: String -> Either Text.Text Script -> Q [Dec]
dumpScript requestedName result = do
  script <- either (fail . Text.unpack) pure result
  runIO . ByteString.writeFile outputName . flat . UPLC.UnrestrictedProgram .
    UPLC.programMapNames UPLC.fakeNameDeBruijn $
      unScript script
  pure []
  where
    outputName = sanitize requestedName <> ".uplc-flat"

sanitize :: String -> String
sanitize requestedName =
  case map replace requestedName of
    "" -> "Plutarch"
    safeName -> safeName
  where
    replace character
      | isAlphaNum character || character == '-' || character == '_' = character
      | otherwise = '_'
